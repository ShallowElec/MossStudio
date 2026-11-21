import { describe, expect, it } from 'vitest'
import type { AgentHubEvent } from '@shared/agentHub'
import { childEnv, createAcpDriver } from '../../../src/main/agentHub/acpDriver'

/** An Agent that keeps one earlier conversation, lists it and replays it on `session/load`; a prompt to it never answers. */
const agent = (capabilities: string) => `
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const update = (sessionUpdate, text) => send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'old-1',update:{sessionUpdate,content:{type:'text',text}}}});
readline.createInterface({input:process.stdin}).on('line', line => {
 const req = JSON.parse(line);
 if(req.method==='initialize') send({jsonrpc:'2.0',id:req.id,result:{protocolVersion:1,agentCapabilities:${capabilities}}});
 if(req.method==='session/list') send({jsonrpc:'2.0',id:req.id,result:{sessions:[{sessionId:'old-1',cwd:'/work/poster',title:'海报',updatedAt:'2026-11-20T10:00:00Z'}]}});
 if(req.method==='session/load') {
  if(req.params.cwd!=='/work/poster') process.exit(4);
  update('user_message_chunk','画一张'); update('user_message_chunk','海报');
  update('agent_message_chunk','好的'); update('agent_message_chunk','，画好了');
  send({jsonrpc:'2.0',id:req.id,result:{}});
 }
});`

const mcp = () => ({ running: false, url: null, token: null, stdioBridgePath: '', discoveryPath: '' })

describe('ACP conversations after a restart', () => {
  it('lists the conversations the Agent keeps and loads one with its history, without streaming the replay', async () => {
    const events: AgentHubEvent[] = []
    const driver = createAcpDriver({ id: 'custom-acp', label: 'Test', emit: (event) => events.push(event), getMcpState: mcp })
    try {
      const info = await driver.connect({
        backendId: driver.id,
        customCommand: process.execPath,
        customArgs: ['-e', agent('{loadSession:true,sessionCapabilities:{list:{}}}')],
      })
      expect(info.resumable).toBe(true)
      expect(await driver.listSessions()).toEqual([
        { id: 'old-1', title: '海报', cwd: '/work/poster', updatedAt: Date.parse('2026-11-20T10:00:00Z') },
      ])
      const page = await driver.readMessages('old-1')
      expect(page.messages.map((message) => [message.role, message.text])).toEqual([
        ['user', '画一张海报'],
        ['assistant', '好的，画好了'],
      ])
      expect(events.filter((event) => event.type === 'delta')).toEqual([])
    } finally {
      await driver.disconnect()
    }
  })

  it('says a conversation cannot be resumed when the Agent cannot load or list them', async () => {
    const driver = createAcpDriver({ id: 'custom-acp', label: 'Test', emit: () => undefined, getMcpState: mcp })
    try {
      const info = await driver.connect({ backendId: driver.id, customCommand: process.execPath, customArgs: ['-e', agent('{}')] })
      expect(info.resumable).toBe(false)
      expect(await driver.listSessions()).toEqual([])
      await expect(driver.readMessages('old-1')).rejects.toThrow('Agent 会话不存在')
    } finally {
      await driver.disconnect()
    }
  })

  it('stops a turn that streams nothing for too long, and tells the Agent to cancel it', async () => {
    const events: AgentHubEvent[] = []
    const driver = createAcpDriver({
      id: 'custom-acp',
      label: 'Test',
      emit: (event) => events.push(event),
      getMcpState: mcp,
      promptIdleMs: 150,
    })
    try {
      await driver.connect({
        backendId: driver.id,
        customCommand: process.execPath,
        customArgs: ['-e', agent('{loadSession:true,sessionCapabilities:{list:{}}}')],
      })
      await driver.listSessions()
      await driver.send({ backendId: driver.id, sessionId: 'old-1', text: '再画一张' })
      const deadline = Date.now() + 3000
      while (!events.some((event) => event.type === 'error') && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20))
      expect(events.find((event) => event.type === 'error')?.message).toContain('很久没有回应')
    } finally {
      await driver.disconnect()
    }
  })

  it('gives a child ELECTRON_RUN_AS_NODE only when it is this app itself', () => {
    expect(childEnv(process.execPath).ELECTRON_RUN_AS_NODE).toBe('1')
    expect(childEnv('/usr/bin/codex-acp').ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})
