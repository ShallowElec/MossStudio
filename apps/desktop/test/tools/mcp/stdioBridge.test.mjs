// The zero-dependency stdio bridge external MCP clients launch (tools/mcp/mossstudio-mcp-stdio.mjs).
import { describe, expect, it } from 'vitest'
import { createBridge, defaultDiscoveryPaths, forwardJsonRpcLine } from '../../../../../tools/mcp/mossstudio-mcp-stdio.mjs'

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

  it('finds the discovery file the app names, before any guessed location', () => {
    expect(defaultDiscoveryPaths({ MOSSSTUDIO_MCP_DISCOVERY: '/data/mcp-server.json' }, 'linux')).toEqual(['/data/mcp-server.json'])
    expect(defaultDiscoveryPaths({ MOSSSTUDIO_DATA: '/d' }, 'linux')[0]).toBe('/d/mcp-server.json')
  })
})
