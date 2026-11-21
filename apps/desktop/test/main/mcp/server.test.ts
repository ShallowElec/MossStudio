import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createBuiltinMainDispatcher, createBuiltinMainHandlers, createMainCapabilityDispatcher } from '../../../src/main/capabilities'
import { sha256Text } from '@shared/capabilities'
import { MCP_PROTOCOL_VERSION, createMcpServer, getActiveMcpServer, startMcpServer, stopMcpServer } from '../../../src/main/mcp/server'

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
    expect(calls.every((call) => !('approved' in call))).toBe(true)
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

/** A raw HTTP request (fetch cannot set Host), resolving to the status and body. */
function post(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  method = 'POST',
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers, signal }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(method === 'POST' ? JSON.stringify(body) : undefined)
  })
}

describe('MCP server: who may connect and what they may call', () => {
  async function withServer(
    run: (
      server: Awaited<ReturnType<typeof createMcpServer>>,
      dispatcher: ReturnType<typeof createMainCapabilityDispatcher>,
    ) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'moss-mcp-guard-'))
    const dispatcher = createMainCapabilityDispatcher({ mainHandlers: createBuiltinMainHandlers(), readFlags: () => ({}) })
    const server = await createMcpServer({ dispatcher, discoveryPath: join(dir, 'mcp-server.json') })
    try {
      await run(server, dispatcher)
    } finally {
      await server.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }
  const auth = (server: { token: string }) => ({ 'content-type': 'application/json', authorization: `Bearer ${server.token}` })
  const rpc = async (server: { url: string; token: string }, method: string, params: unknown = {}) =>
    JSON.parse((await post(server.url, { jsonrpc: '2.0', id: 1, method, params }, auth(server))).body) as {
      result: Record<string, unknown> & { isError?: boolean; content?: Array<{ text: string }> }
    }

  it('refuses a request from a web page (Origin) or under another host name, and keeps /health behind the token', async () => {
    await withServer(async (server) => {
      const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }
      expect((await post(server.url, ping, { ...auth(server), origin: 'https://evil.example' })).status).toBe(403)
      expect((await post(server.url, ping, { ...auth(server), host: `rebind.example:${server.port}` })).status).toBe(403)
      expect((await post(server.url, ping, auth(server))).status).toBe(200)
      const health = server.url.replace(/\/mcp$/, '/health')
      expect((await post(health, null, {}, 'GET')).status).toBe(401)
      expect((await post(health, null, auth(server), 'GET')).status).toBe(200)
    })
  })

  it('answers initialize with a protocol version it speaks', async () => {
    await withServer(async (server) => {
      expect((await rpc(server, 'initialize', { protocolVersion: '2024-11-05' })).result.protocolVersion).toBe('2024-11-05')
      expect((await rpc(server, 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    })
  })

  it('never offers the ask cards, which only the 助手 chat shows, whatever the profile', async () => {
    await withServer(async (server) => {
      for (const profile of ['compact', 'atomic'] as const) {
        server.setProfile(profile)
        const tools = (await rpc(server, 'tools/list')).result.tools as Array<{ name: string }>
        expect(tools.some((tool) => tool.name.startsWith('studio__ask'))).toBe(false)
        expect(tools.length).toBeGreaterThan(0)
      }
    })
  })

  it('serves the audit trail only to a profile that offers the tool that reads it', async () => {
    await withServer(async (server) => {
      server.setProfile('custom', ['models.catalog'])
      expect(await rpc(server, 'resources/read', { uri: 'mossstudio://audit/recent' })).toHaveProperty('error')
      server.setProfile('atomic')
      expect(await rpc(server, 'resources/read', { uri: 'mossstudio://audit/recent' })).toHaveProperty('result')
    })
  })

  it('refuses a tool the active profile does not offer, even one the registry has', async () => {
    await withServer(async (server) => {
      server.setProfile('custom', ['models.catalog'])
      const refused = (await rpc(server, 'tools/call', { name: 'manga__series__list' })).result
      expect(refused.isError).toBe(true)
      expect(refused.content![0]!.text).toContain('不在当前开放的工具里')
      expect((await rpc(server, 'tools/call', { name: 'models__control_adapters__list' })).result.isError).toBe(false)
    })
  })

  it('drops a call still waiting for approval when the client hangs up', async () => {
    await withServer(async (server, dispatcher) => {
      let waiting: AbortSignal | undefined
      dispatcher.requestApproval = (_request, signal) =>
        new Promise((resolve) => {
          waiting = signal
          signal?.addEventListener('abort', () => resolve(false))
        })
      const hangUp = new AbortController()
      const call = post(
        server.url,
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'models__catalog__delete', arguments: { kind: 'model', id: 'y' } } },
        auth(server),
        'POST',
        hangUp.signal,
      ).catch(() => null)
      await vi.waitFor(() => expect(waiting).toBeDefined())
      expect(waiting!.aborted).toBe(false)
      hangUp.abort()
      await call
      await vi.waitFor(() => expect(waiting!.aborted).toBe(true))
    })
  })
})

it('starts one server when two callers start it at the same time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moss-mcp-once-'))
  const dispatcher = createMainCapabilityDispatcher({ mainHandlers: {}, readFlags: () => ({}) })
  try {
    const [a, b] = await Promise.all([
      startMcpServer({ dispatcher, discoveryPath: join(dir, 'a.json') }),
      startMcpServer({ dispatcher, discoveryPath: join(dir, 'b.json') }),
    ])
    expect(a).toBe(b)
    expect(getActiveMcpServer()).toBe(a)
  } finally {
    await stopMcpServer()
    await rm(dir, { recursive: true, force: true })
  }
})
