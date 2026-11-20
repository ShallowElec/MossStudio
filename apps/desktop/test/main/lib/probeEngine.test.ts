import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENGINE_PROTOCOL_VERSION } from '@shared/engineProtocol'
import { stopEngineRequests, withEngineRequests } from '@main/lib/probeEngine'
import { useTempDir } from '@test/helpers/tempDir'

const temp = useTempDir('mossstudio-probe-engine-')

/** A stand-in moss-server: Node runs it (spawnEngineServer starts `.mjs` files with this runtime). */
async function server(body: string): Promise<string> {
  const file = join(temp(), 'moss-server.mjs')
  await writeFile(
    file,
    `import { createInterface } from 'node:readline'
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
const hello = { protocol_version: ${ENGINE_PROTOCOL_VERSION}, capabilities: { inspect: true } }
setInterval(() => {}, 1000)
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  ${body}
})
`,
  )
  return file
}

describe('withEngineRequests', () => {
  it('runs the requests after hello through one sidecar', async () => {
    const path = await server(`if (method === 'hello') reply(id, hello); else reply(id, { kind: 'dit', path: params.path })`)
    const results = await withEngineRequests(path, async (request) => [
      await request('inspect', { path: 'a' }),
      await request('inspect', { path: 'b' }),
    ])
    expect(results).toEqual([
      { kind: 'dit', path: 'a' },
      { kind: 'dit', path: 'b' },
    ])
  })

  it('matches overlapping requests to their answers, which may come out of order', async () => {
    // The engine answers an inspect when it is done: here the first one asked finishes last.
    const path = await server(
      `if (method === 'hello') reply(id, hello); else setTimeout(() => reply(id, { path: params.path }), params.path === 'slow' ? 80 : 5)`,
    )
    const results = await withEngineRequests(path, (request) =>
      Promise.all([request('inspect', { path: 'slow' }), request('inspect', { path: 'fast' })]),
    )
    expect(results).toEqual([{ path: 'slow' }, { path: 'fast' }])
  })

  it('fails when the engine exits before answering', async () => {
    const path = await server(`process.exit(3)`)
    await expect(withEngineRequests(path, async () => 'never')).rejects.toThrow('moss-server 已退出：3')
  })

  it('times out a hello or a request that gets no answer', async () => {
    const silent = await server(``)
    await expect(withEngineRequests(silent, async () => 'never', { helloMs: 100 })).rejects.toThrow('moss-server 请求超时：hello')
    const helloOnly = await server(`if (method === 'hello') reply(id, hello)`)
    await expect(withEngineRequests(helloOnly, (request) => request('inspect', { path: 'a' }), { requestMs: 100 })).rejects.toThrow(
      'moss-server 请求超时：inspect',
    )
  })

  it('refuses an engine whose hello says it cannot inspect', async () => {
    const path = await server(`reply(id, { ...hello, capabilities: { inspect: false } })`)
    await expect(withEngineRequests(path, async () => 'never')).rejects.toThrow('请更新 MossInfer')
  })

  it('ends a sidecar still running when the app quits', async () => {
    const path = await server(`if (method === 'hello') reply(id, hello)`)
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const pending = withEngineRequests(path, (request) => {
      started()
      return request('inspect', { path: 'a' })
    })
    await running
    stopEngineRequests()
    await expect(pending).rejects.toThrow('moss-server 已退出')
  })
})
