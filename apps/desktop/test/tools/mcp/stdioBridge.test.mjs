// The zero-dependency stdio bridge external MCP clients launch (tools/mcp/mossstudio-mcp-stdio.mjs).
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { anySignal, createBridge, defaultDiscoveryPaths, forwardJsonRpcLine } from '../../../../../tools/mcp/mossstudio-mcp-stdio.mjs'
import { createMainCapabilityDispatcher } from '../../../src/main/capabilities'
import { createMcpServer, MCP_PROTOCOL_VERSION, MCP_SUPPORTED_VERSIONS, MCP_WORKFLOW_INSTRUCTIONS } from '../../../src/main/mcp/server'
import { useTempDataRoot } from '../../helpers/tempDir'

const env = { MOSSSTUDIO_MCP_URL: 'http://127.0.0.1:4321/mcp', MOSSSTUDIO_MCP_TOKEN: 'test-token-0123456789' }

const reply = (body) => ({ status: 200, text: async () => JSON.stringify(body) })

describe('tools/mcp stdio bridge', () => {
  it('forwards with a bounded signal and reports a failed request as a JSON-RPC error', async () => {
    const controller = new AbortController()
    let requestSignal
    const result = await forwardJsonRpcLine(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      env,
      async (_url, options) => {
        requestSignal = options.signal
        controller.abort()
        options.signal.throwIfAborted()
      },
      controller.signal,
    )
    expect(result.error.code).toBe(-32002)
    expect(requestSignal.aborted).toBe(true)
  })

  it('sends the bearer token and gives no reply to a notification', async () => {
    let headers
    const notification = await forwardJsonRpcLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', env, async (_url, options) => {
      headers = options.headers
      return { status: 202, text: async () => '' }
    })
    expect(notification).toBeNull()
    expect(headers.authorization).toBe('Bearer test-token-0123456789')
  })

  it('runs independent calls side by side, so a slow tool does not hold up ping', async () => {
    const written = []
    let release
    const bridge = createBridge({
      env,
      write: (message) => written.push(message),
      fetchImpl: (_url, options) => {
        const { id } = JSON.parse(options.body)
        if (id === 1) return new Promise((resolve) => (release = () => resolve(reply({ jsonrpc: '2.0', id: 1, result: {} }))))
        return Promise.resolve(reply({ jsonrpc: '2.0', id, result: {} }))
      },
    })
    const slow = bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}')
    await bridge.handleLine('{"jsonrpc":"2.0","id":2,"method":"ping"}')
    expect(written.map((message) => message.id)).toEqual([2])
    release()
    await slow
    expect(written.map((message) => message.id)).toEqual([2, 1])
  })

  it('aborts the request a client cancelled (its tool timeout), so MossStudio drops the waiting approval', async () => {
    const written = []
    let callSignal
    const bridge = createBridge({
      env,
      write: (message) => written.push(message),
      fetchImpl: (_url, options) => {
        const body = JSON.parse(options.body)
        if (body.method === 'tools/call') {
          callSignal = options.signal
          return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
        }
        return Promise.resolve({ status: 202, text: async () => '' })
      },
    })
    const call = bridge.handleLine('{"jsonrpc":"2.0","id":"call-7","method":"tools/call","params":{"name":"x"}}')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(callSignal.aborted).toBe(false)
    await bridge.handleLine('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"call-7"}}')
    await call
    expect(callSignal.aborted).toBe(true)
    expect(written).toEqual([])
  })

  it('stops every request when stdin closes', async () => {
    let callSignal
    const bridge = createBridge({
      env,
      write: () => undefined,
      fetchImpl: (_url, options) => {
        callSignal = options.signal
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
      },
    })
    void bridge.handleLine('{"jsonrpc":"2.0","id":3,"method":"tools/call"}')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await bridge.close()
    expect(callSignal.aborted).toBe(true)
  })

  it('combines signals without AbortSignal.any, which older node lacks', () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = anySignal([a.signal, b.signal])
    expect(combined.aborted).toBe(false)
    b.abort('gone')
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('gone')
    expect(anySignal([AbortSignal.abort('x')]).aborted).toBe(true)
  })

  it('finds the discovery file the app names, before any guessed location', () => {
    expect(defaultDiscoveryPaths({ MOSSSTUDIO_MCP_DISCOVERY: '/data/mcp-server.json' }, 'linux')).toEqual(['/data/mcp-server.json'])
    const data = join(tmpdir(), 'moss-data')
    expect(defaultDiscoveryPaths({ MOSSSTUDIO_DATA: data }, process.platform)[0]).toBe(join(data, 'mcp-server.json'))
  })
})

describe('tools/mcp stdio bridge while MossStudio comes and goes', () => {
  const root = useTempDataRoot()
  const file = () => join(root(), 'mcp-server.json')
  const script = new URL('../../../../../tools/mcp/mossstudio-mcp-stdio.mjs', import.meta.url)
  const direct = { MOSSSTUDIO_MCP_URL: 'http://127.0.0.1:50101/mcp', MOSSSTUDIO_MCP_TOKEN: 'test-token-first-endpoint' }
  const pin = () => ({ MOSSSTUDIO_MCP_DISCOVERY: file() })
  const line = (method, id, params) => JSON.stringify({ jsonrpc: '2.0', method, id, params })
  const changes = ['prompts', 'resources', 'tools'].map((name) => ({ jsonrpc: '2.0', method: `notifications/${name}/list_changed` }))
  const capabilities = { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } }
  // A short poll keeps the waits below in the tens of milliseconds.
  const pollMs = 20
  const timedOut = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')

  function serve(readFlags = () => ({})) {
    return createMcpServer({ discoveryPath: file(), dispatcher: createMainCapabilityDispatcher({ mainHandlers: {}, readFlags }) })
  }
  async function expectChanges(packets, timeout = 4000) {
    await vi.waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(3), { timeout })
    // The short poll may also see the moment between one server stopping and the next starting.
    await new Promise((resolve) => setTimeout(resolve, 10 * pollMs))
    const sent = packets.splice(0)
    expect(sent.length % 3).toBe(0)
    expect(new Set(sent.map((packet) => JSON.stringify(packet)))).toEqual(new Set(changes.map((packet) => JSON.stringify(packet))))
  }

  it('keeps the stdio session alive from offline initialize through the first real tool list, then exits on EOF', async () => {
    const child = spawn(process.execPath, [fileURLToPath(script)], {
      env: { ...process.env, ...pin(), MOSSSTUDIO_MCP_URL: '', MOSSSTUDIO_MCP_TOKEN: '' },
      windowsHide: true,
    })
    const exited = once(child, 'exit')
    const packets = []
    createInterface({ input: child.stdout }).on('line', (text) => packets.push(JSON.parse(text)))
    const send = (method, id, params) => child.stdin.write(line(method, id, params) + '\n')
    const request = async (method, id, params) => {
      send(method, id, params)
      await vi.waitFor(() => expect(packets[0]?.id).toBe(id))
      return packets.shift()
    }
    let server
    try {
      expect(await request('initialize', 0, { protocolVersion: '2025-06-18' })).toMatchObject({
        jsonrpc: '2.0',
        result: { protocolVersion: '2025-06-18', capabilities, serverInfo: { name: expect.any(String), version: expect.any(String) } },
      })
      send('notifications/initialized')
      for (const [method, result] of Object.entries({
        ping: {},
        'tools/list': { tools: [] },
        'resources/list': { resources: [] },
        'resources/templates/list': { resourceTemplates: [] },
        'prompts/list': { prompts: [] },
      }))
        expect(await request(method, method)).toEqual({ jsonrpc: '2.0', id: method, result })
      expect(await request('tools/call', 'write')).toMatchObject({
        id: 'write',
        error: { code: -32001, message: expect.stringMatching(/launch|start/i) },
      })
      server = await serve()
      // The real CLI polls at its own pace, backing off while offline.
      await expectChanges(packets, 10000)
      const actual = await request('tools/list', 'live')
      const response = await fetch(server.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}` },
        body: line('tools/list', 'live'),
      })
      expect(actual).toEqual(await response.json())
      expect(actual.result.tools).toContainEqual(expect.objectContaining({ name: 'models__catalog__installed' }))
      child.stdin.end()
      await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 5000 })
    } finally {
      if (child.exitCode === null) child.kill()
      await exited
      await server?.stop()
    }
  }, 20000)

  it('notifies on replacement, profile, live feature flags and loss of reachability even with stale discovery', async () => {
    let remoteHostsEnabled = false
    let server
    const packets = []
    const bridge = createBridge({ env: pin(), pollMs, write: (packet) => packets.push(packet) })
    const ask = async (method) => {
      await bridge.handleLine(line(method, 0))
      return packets.pop()
    }
    try {
      await ask('initialize')
      await bridge.handleLine(line('notifications/initialized'))
      server = await serve(() => ({ remoteHostsEnabled }))
      await expectChanges(packets)
      const online = await forwardJsonRpcLine(line('initialize', 0), pin())
      expect(online?.result).toMatchObject({ capabilities, instructions: expect.stringContaining('MossStudio') })
      const first = server
      const oldFile = await readFile(file(), 'utf8')
      await first.stop()
      server = await serve(() => ({ remoteHostsEnabled }))
      expect(server.url).not.toBe(first.url)
      expect(server.token).not.toBe(first.token)
      await expectChanges(packets)
      expect((await ask('tools/list'))?.result?.tools).toContainEqual(expect.objectContaining({ name: 'models__catalog__installed' }))
      server.setProfile('atomic')
      await expectChanges(packets)
      const snapshot = await readFile(file(), 'utf8')
      remoteHostsEnabled = true
      await expectChanges(packets)
      expect(await readFile(file(), 'utf8')).toBe(snapshot)
      expect((await ask('tools/list'))?.result?.tools).toContainEqual(expect.objectContaining({ name: 'remote__hosts__list' }))
      await server.stop()
      await writeFile(file(), oldFile)
      await expectChanges(packets)
      expect(await ask('tools/list')).toEqual({ jsonrpc: '2.0', id: 0, result: { tools: [] } })
      expect(await ask('ping')).toMatchObject({ result: {} })
      expect(await ask('initialize')).toMatchObject({ result: { capabilities } })
    } finally {
      await bridge.close()
      await server?.stop()
    }
  }, 16000)

  it('notifies if the server that answered initialize stops before the first health check', async () => {
    const server = await serve()
    const packets = []
    const bridge = createBridge({ env: pin(), pollMs, write: (packet) => packets.push(packet) })
    try {
      await bridge.handleLine(line('initialize', 1))
      expect(packets.pop()?.result?.instructions).toEqual(expect.stringContaining('MossStudio'))
      await server.stop()
      await bridge.handleLine(line('notifications/initialized'))
      await expectChanges(packets)
    } finally {
      await bridge.close()
      await server.stop()
    }
  })

  it('answers offline initialize with every version the server speaks, else with the server default', async () => {
    for (const version of MCP_SUPPORTED_VERSIONS)
      expect((await forwardJsonRpcLine(line('initialize', 0, { protocolVersion: version }), pin()))?.result?.protocolVersion).toBe(version)
    expect((await forwardJsonRpcLine(line('initialize', 0, { protocolVersion: '1999-01-01' }), pin()))?.result?.protocolVersion).toBe(
      MCP_PROTOCOL_VERSION,
    )
  })

  it('gives an offline initialize the same workflow guidance the server gives', async () => {
    const offline = await forwardJsonRpcLine(line('initialize', 0), pin())
    expect(offline?.result?.instructions).toContain(MCP_WORKFLOW_INSTRUCTIONS)
    const server = await serve()
    try {
      expect((await forwardJsonRpcLine(line('initialize', 0), pin()))?.result?.instructions).toContain(MCP_WORKFLOW_INSTRUCTIONS)
    } finally {
      await server.stop()
    }
  })

  it('does not tell a freshly initialized client its catalog changed when the discovery file and health differ', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      if (!init?.body) return Response.json({ ok: true, protocol: 'mcp', profile: 'compact', skillDigest: 'd' })
      const { id } = JSON.parse(init.body)
      return id === undefined ? new Response(null, { status: 202 }) : Response.json({ jsonrpc: '2.0', id, result: { capabilities: {} } })
    })
    const packets = []
    const bridge = createBridge({ env: direct, fetchImpl, pollMs, write: (packet) => packets.push(packet) })
    try {
      await bridge.handleLine(line('initialize', 0))
      await bridge.handleLine(line('notifications/initialized'))
      await vi.waitFor(() => expect(fetchImpl.mock.calls.filter(([, init]) => !init?.body).length).toBeGreaterThan(2))
      expect(packets).toEqual([{ jsonrpc: '2.0', id: 0, result: { capabilities } }])
    } finally {
      await bridge.close()
    }
  })

  it('reports a list that timed out as an error, never an empty catalog, and has the client ask again once healthy', async () => {
    let slow = true
    const fetchImpl = vi.fn(async (url, init) => {
      if (!init?.body) return Response.json({ ok: true, protocol: 'mcp', profile: 'compact', skillDigest: 'd' })
      const { id, method } = JSON.parse(init.body)
      if (method === 'tools/list' && slow) throw timedOut()
      return Response.json({ jsonrpc: '2.0', id, result: method === 'tools/list' ? { tools: [{ name: 'a' }] } : { capabilities: {} } })
    })
    const packets = []
    const bridge = createBridge({ env: direct, fetchImpl, pollMs, write: (packet) => packets.push(packet) })
    try {
      await bridge.handleLine(line('initialize', 0))
      await bridge.handleLine(line('notifications/initialized'))
      await vi.waitFor(() => expect(fetchImpl.mock.calls.filter(([, init]) => !init?.body).length).toBeGreaterThan(1))
      packets.splice(0)
      await bridge.handleLine(line('tools/list', 1))
      expect(packets.shift()).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: expect.stringContaining('in time') } })
      slow = false
      await expectChanges(packets)
      await bridge.handleLine(line('tools/list', 2))
      expect(packets.shift()).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'a' }] } })
    } finally {
      await bridge.close()
    }
  })

  it.each([
    ['timed out', () => Promise.reject(timedOut())],
    [
      'dropped',
      () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })),
    ],
    [
      'dropped after its headers',
      async () => ({
        status: 200,
        text: () =>
          Promise.reject(new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })),
      }),
    ],
  ])('never invites a retry of a tool call that %s, since it may have run', async (_failure, failure) => {
    const packet = await forwardJsonRpcLine(line('tools/call', 'gen', { name: 'create' }), direct, failure)
    expect(packet).toEqual({ jsonrpc: '2.0', id: 'gen', error: { code: -32002, message: expect.stringContaining('may still') } })
    expect(packet.error.message).not.toMatch(/retry|launch/i)
  })

  it('says MossStudio is not running when a tool call cannot reach it at all', async () => {
    const closed = createServer()
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const { port } = closed.address()
    await new Promise((resolve) => closed.close(resolve))
    const refused = { MOSSSTUDIO_MCP_URL: `http://127.0.0.1:${port}/mcp`, MOSSSTUDIO_MCP_TOKEN: direct.MOSSSTUDIO_MCP_TOKEN }
    for (const env of [pin(), refused])
      expect(await forwardJsonRpcLine(line('tools/call', 'gen'), env)).toMatchObject({
        error: { code: -32001, message: expect.stringMatching(/launch/i) },
      })
  })

  it('moves on from a dead install’s leftover discovery file to a live install found later', async () => {
    const live = join(root(), 'live')
    await mkdir(live)
    // Guessed per-user locations point into the temp folder, so an install on this machine cannot interfere.
    const env = {
      MOSSSTUDIO_DATA_ROOT: root(),
      MOSSSTUDIO_DATA: live,
      XDG_DATA_HOME: live,
      XDG_CONFIG_HOME: live,
      LOCALAPPDATA: live,
      APPDATA: live,
    }
    const { pid } = spawnSync(process.execPath, ['-e', ''])
    await writeFile(file(), JSON.stringify({ url: direct.MOSSSTUDIO_MCP_URL, token: direct.MOSSSTUDIO_MCP_TOKEN, pid }))
    const fresh = { url: 'http://127.0.0.1:50102/mcp', token: 'test-token-second-endpoint' }
    const fetchImpl = vi.fn(async (url) => {
      if (String(url) !== fresh.url)
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })
      return Response.json({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'live' }] } })
    })
    const write = vi.fn()
    const bridge = createBridge({ env, fetchImpl, pollMs, write })
    try {
      await bridge.handleLine(line('tools/list', 1))
      expect(write).toHaveBeenLastCalledWith({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
      await writeFile(join(live, 'mcp-server.json'), JSON.stringify({ ...fresh, pid: process.pid }))
      await bridge.handleLine(line('tools/list', 2))
      expect(write).toHaveBeenLastCalledWith({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'live' }] } })
    } finally {
      await bridge.close()
    }
  })

  it('never answers a response the client sends back, nor lets it take over a request id', async () => {
    const fetchImpl = vi.fn()
    expect(await forwardJsonRpcLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), direct, fetchImpl)).toBeNull()
    expect(
      await forwardJsonRpcLine(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'no' } }), direct, fetchImpl),
    ).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()

    let callSignal
    const write = vi.fn()
    const bridge = createBridge({
      env: direct,
      write,
      fetchImpl: (_url, options) => {
        if (JSON.parse(options.body).method !== 'tools/call') return Promise.resolve(new Response(null, { status: 202 }))
        callSignal = options.signal
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
      },
    })
    const call = bridge.handleLine(line('tools/call', 7))
    await vi.waitFor(() => expect(callSignal).toBeDefined())
    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} }))
    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }))
    await call
    expect(callSignal.aborted).toBe(true)
    expect(write).not.toHaveBeenCalled()
    await bridge.close()
  })

  it.each(['401', 'non-rpc', 'connection refused'])('rereads the pinned file once after %s during a list request', async (failure) => {
    const old = { url: direct.MOSSSTUDIO_MCP_URL, token: direct.MOSSSTUDIO_MCP_TOKEN }
    const fresh = { url: 'http://127.0.0.1:50102/mcp', token: 'test-token-second-endpoint' }
    await writeFile(file(), JSON.stringify(old))
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url) === old.url) {
        await writeFile(file(), JSON.stringify(fresh))
        if (failure === 'connection refused') throw new TypeError('fetch failed')
        return failure === '401' ? Response.json({ error: 'Unauthorized' }, { status: 401 }) : Response.json({})
      }
      expect([String(url), new Headers(init?.headers).get('authorization')]).toEqual([fresh.url, `Bearer ${fresh.token}`])
      return Response.json({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'fresh' }] } })
    })
    expect(await forwardJsonRpcLine(line('tools/list', 'list'), pin(), fetchImpl)).toEqual({
      jsonrpc: '2.0',
      id: 'list',
      result: { tools: [{ name: 'fresh' }] },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('answers the empty offline list when the retry after a 401 finds nothing listening', async () => {
    const old = { url: direct.MOSSSTUDIO_MCP_URL, token: direct.MOSSSTUDIO_MCP_TOKEN }
    await writeFile(file(), JSON.stringify(old))
    const fetchImpl = vi.fn(async (url) => {
      if (String(url) !== old.url)
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })
      await writeFile(file(), JSON.stringify({ url: 'http://127.0.0.1:50102/mcp', token: 'test-token-second-endpoint' }))
      return new Response(null, { status: 401 })
    })
    expect(await forwardJsonRpcLine(line('tools/list', 'list'), pin(), fetchImpl)).toEqual({
      jsonrpc: '2.0',
      id: 'list',
      result: { tools: [] },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each(['401', 'non-rpc'])('preserves the %s list error when discovery vanishes before the retry', async (failure) => {
    await writeFile(file(), JSON.stringify({ url: direct.MOSSSTUDIO_MCP_URL, token: direct.MOSSSTUDIO_MCP_TOKEN }))
    const fetchImpl = vi.fn(async () => {
      await rm(file())
      return failure === '401' ? new Response(null, { status: 401 }) : Response.json({})
    })
    expect(await forwardJsonRpcLine(line('resources/list', 'res'), pin(), fetchImpl)).toEqual({
      jsonrpc: '2.0',
      id: 'res',
      error: { code: expect.any(Number), message: expect.any(String) },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(['initialize', 'ping', 'tools/call', 'resources/read', 'prompts/get'])(
    'does not retry %s when the pinned endpoint rejects the request',
    async (method) => {
      await writeFile(file(), JSON.stringify({ url: direct.MOSSSTUDIO_MCP_URL, token: direct.MOSSSTUDIO_MCP_TOKEN }))
      const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }))
      expect(await forwardJsonRpcLine(line(method, 0), pin(), fetchImpl)).toEqual({
        jsonrpc: '2.0',
        id: 0,
        error: { code: expect.any(Number), message: expect.stringContaining('401') },
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['unauthorized', () => Response.json({ error: 'Unauthorized' }, { status: 401 })],
    ['HTTP error with a success envelope', () => Response.json({ jsonrpc: '2.0', id: 'original', result: {} }, { status: 500 })],
    ['HTML', () => new Response('<html>Offline</html>')],
    ['empty 202', () => new Response(null, { status: 202 })],
    ['empty 204', () => new Response(null, { status: 204 })],
    ['wrong ID', () => Response.json({ jsonrpc: '2.0', id: 1, result: {} })],
    ['invalid error', () => Response.json({ jsonrpc: '2.0', id: 'original', error: 'unauthorized' })],
    ['ambiguous envelope', () => Response.json({ jsonrpc: '2.0', id: 'original', result: {}, error: { code: -1, message: 'bad' } })],
    [
      'connection lost',
      () => {
        throw new TypeError('fetch failed')
      },
    ],
  ])('returns a correlated error for %s without ever replaying a tool call or replying to a notification', async (failure, response) => {
    const fetchImpl = vi.fn(async () => response())
    const packet = await forwardJsonRpcLine(line('tools/call', 'original', { name: 'create' }), direct, fetchImpl)
    expect(packet).toEqual({ jsonrpc: '2.0', id: 'original', error: { code: -32002, message: expect.any(String) } })
    if (failure === 'unauthorized') expect(packet?.error?.message).toContain('401')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await forwardJsonRpcLine(line('notifications/initialized'), direct, fetchImpl)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retain completed requests for cancellation on EOF', async () => {
    const signals = []
    const fetchImpl = async (_url, options) => {
      signals.push(options.signal)
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
    }
    const bridge = createBridge({ env: direct, fetchImpl, write: vi.fn() })
    const lateAbort = vi.fn()
    try {
      for (let i = 0; i < 20; i++) await bridge.handleLine(line('tools/call', 1))
      for (const signal of signals) signal.addEventListener('abort', lateAbort)
    } finally {
      await bridge.close()
    }
    expect(signals).toHaveLength(20)
    expect(lateAbort).not.toHaveBeenCalled()
  })

  it('never monitors before initialized or after close, aborts an outstanding probe and never creates a second timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    let probe
    const fetchImpl = vi.fn(async (_url, init) => {
      if (init?.body) return new Response(null, { status: 202 })
      probe = init?.signal
      return new Promise((_resolve, reject) => probe?.addEventListener('abort', () => reject(new Error('closed'))))
    })
    const write = vi.fn()
    const bridge = createBridge({ env: direct, fetchImpl, write })
    try {
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetchImpl).not.toHaveBeenCalled()
      const init = bridge.handleLine(line('notifications/initialized'))
      await vi.advanceTimersByTimeAsync(6000)
      const duplicate = bridge.handleLine(line('notifications/initialized'))
      await vi.advanceTimersByTimeAsync(6000)
      expect(fetchImpl.mock.calls.filter(([, options]) => !options?.body)).toHaveLength(1)
      expect(probe?.aborted).toBe(false)
      await bridge.close()
      await Promise.all([init, duplicate])
      expect(probe?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      const calls = fetchImpl.mock.calls.length
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetchImpl).toHaveBeenCalledTimes(calls)
      expect(write).not.toHaveBeenCalled()
    } finally {
      await bridge.close()
      vi.useRealTimers()
    }
  })

  it('polls less often while MossStudio is away, and at the normal pace again once it is back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let online = false
    const fetchImpl = vi.fn(async (_url, init) => {
      if (init?.body) return new Response(null, { status: 202 })
      if (!online) throw new TypeError('fetch failed')
      return Response.json({ ok: true, protocol: 'mcp', profile: 'compact', skillDigest: 'd' })
    })
    const probes = () => fetchImpl.mock.calls.filter(([, options]) => !options?.body).length
    const write = vi.fn()
    const bridge = createBridge({ env: direct, fetchImpl, write })
    try {
      await bridge.handleLine(line('notifications/initialized'))
      // Every 1.5 s this would be 14 probes; backing off to 4.5 s it is 6 (0, 2.25, 5.625, 10.125, 14.625, 19.125 s).
      await vi.advanceTimersByTimeAsync(20_000)
      expect(probes()).toBe(6)
      online = true
      await vi.advanceTimersByTimeAsync(4500)
      expect(probes()).toBe(7)
      expect(write).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(3000)
      expect(probes()).toBe(9)
    } finally {
      await bridge.close()
      vi.useRealTimers()
    }
  })

  it('does not escape an explicit discovery pin, even if a different file and direct endpoint are available', async () => {
    const server = await serve()
    const missing = join(root(), 'absent.json')
    const env = {
      MOSSSTUDIO_MCP_DISCOVERY: missing,
      MOSSSTUDIO_DATA_ROOT: root(),
      MOSSSTUDIO_MCP_URL: server.url,
      MOSSSTUDIO_MCP_TOKEN: server.token,
    }
    const fetchImpl = vi.fn(fetch)
    const write = vi.fn()
    const bridge = createBridge({ env, fetchImpl, pollMs, write })
    try {
      await bridge.handleLine(line('notifications/initialized'))
      await bridge.handleLine(line('tools/list', 1))
      expect(write).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(env.MOSSSTUDIO_MCP_DISCOVERY).toBe(missing)
    } finally {
      await bridge.close()
      await server.stop()
    }
  })

  it('sticks with the discovery file already selected by default resolution while it is absent', async () => {
    const env = { MOSSSTUDIO_DATA_ROOT: root(), MOSSSTUDIO_DATA: join(root(), 'other') }
    const server = await serve()
    const fetchImpl = vi.fn(fetch)
    const write = vi.fn()
    const bridge = createBridge({ env, fetchImpl, write })
    try {
      await bridge.handleLine(line('tools/list', 0))
      expect(write.mock.lastCall?.[0].result.tools.length).toBeGreaterThan(0)
      const other = await createMcpServer({ discoveryPath: join(env.MOSSSTUDIO_DATA, 'mcp-server.json') })
      try {
        await rm(file())
        fetchImpl.mockClear()
        await bridge.handleLine(line('tools/list', 1))
        expect(write.mock.lastCall?.[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
        expect(fetchImpl).not.toHaveBeenCalled()
      } finally {
        await other.stop()
      }
    } finally {
      await bridge.close()
      await server.stop()
    }
  })
})
