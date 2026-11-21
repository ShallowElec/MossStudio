import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createBuiltinMainDispatcher, createBuiltinMainHandlers, createMainCapabilityDispatcher } from '../../../src/main/capabilities'
import { sha256Text } from '@shared/capabilities'
import { createMcpServer } from '../../../src/main/mcp/server'

it('never accepts client approval or reuses client ids, and hashes the returned guide', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moss-mcp-security-'))
  const dispatcher = createBuiltinMainDispatcher()
  const execute = vi.spyOn(dispatcher, 'execute').mockResolvedValue({ ok: true, data: {} } as never)
  const server = await createMcpServer({ dispatcher, discoveryPath: join(dir, 'mcp-server.json') })
  try {
    for (const name of ['models.catalog.installed', 'models.catalog.installed', 'system.guide.read']) {
      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, _meta: { approved: true } } }),
      })
      const body = (await response.json()) as { result: { content: Array<{ text: string }> } }
      if (name === 'system.guide.read') {
        const guide = JSON.parse(body.result.content[0].text)
        expect(guide.digest).toBe(sha256Text(guide.markdown))
      }
    }
    const calls = execute.mock.calls.map(([call]) => call)
    expect(calls.every((call) => call.approved === false)).toBe(true)
    expect(new Set(calls.map((call) => call.callId)).size).toBe(3)
    expect(calls.every((call) => /^mcp-[0-9a-f-]{36}$/.test(call.callId!))).toBe(true)
  } finally {
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

it('serves authenticated loopback discovery, six resources and two prompts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moss-mcp-'))
  const dispatcher = createMainCapabilityDispatcher({
    mainHandlers: createBuiltinMainHandlers(),
    readFlags: () => ({ remoteHostsEnabled: true, workerHostsEnabled: true }),
  })
  const server = await createMcpServer({ dispatcher, discoveryPath: join(dir, 'mcp-server.json') })
  try {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(server.token.length).toBeGreaterThanOrEqual(43)
    const discovery = JSON.parse(await readFile(server.discoveryPath, 'utf8'))
    expect(discovery.token).toBe(server.token)
    const request = (method: string, token = server.token) =>
      fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
      })
    expect((await request('ping', 'invalid')).status).toBe(401)
    const resources = (await (await request('resources/list')).json()) as { result: { resources: unknown[] } }
    expect(resources.result.resources).toHaveLength(6)
    const prompts = (await (await request('prompts/list')).json()) as { result: { prompts: unknown[] } }
    expect(prompts.result.prompts).toHaveLength(2)
    const tools = (await (await request('tools/list')).json()) as { result: { tools: Array<{ name: string }> } }
    expect(tools.result.tools.some((tool) => tool.name === 'models__catalog__installed')).toBe(true)
    for (const action of ['list', 'test', 'status', 'loras_list', 'lora_register', 'select']) {
      expect(tools.result.tools.some((tool) => tool.name === `remote__hosts__${action}`)).toBe(true)
    }
  } finally {
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
