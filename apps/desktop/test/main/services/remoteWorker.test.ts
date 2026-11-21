import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWorkerLoraId, parseWorkerSelection, type RemoteWorkerProfile } from '../../../src/shared/remoteWorker'
import {
  runRemoteWorkerJob,
  cancelRemoteWorkerJob,
  changeRemoteWorkerLora,
  getMemoryWorkerToken,
  listRemoteWorkerLoras,
  requestWorkerDaemon,
  resolveRemoteWorkerAdapters,
  setMemoryWorkerToken,
} from '../../../src/main/services/remoteWorker'
import {
  connectWorkerHost,
  disconnectWorkerHost,
  listActiveWorkerProfiles,
  stopAllWorkerHostTunnels,
  validateWorkerRemotePath,
  workerEngineFeatures,
  type WorkerHostConfig,
  type WorkerHostDeps,
} from '../../../src/main/services/workerHostManager'

vi.mock('../../../src/main/services/ssh', () => ({
  posixQuote: (s: string) => `'${s}'`,
  sshCommand: vi.fn(),
  sshEnv: vi.fn(),
  sshExec: vi.fn(),
  sshTunnelArgs: vi.fn(),
}))
vi.mock('../../../src/main/services/sshHostKeys', () => ({ trustUnknownHost: vi.fn() }))

const profile: RemoteWorkerProfile = {
  id: 'worker-test',
  label: 'Test worker',
  kind: 'worker-daemon',
  baseUrl: 'http://127.0.0.1:41000',
  hostId: 'test',
  workflow: 'default',
}
const host: WorkerHostConfig = {
  id: 'test',
  name: 'Test',
  kind: 'ssh',
  host: 'worker.example',
  user: 'runner',
  trainerRoot: '/srv/worker',
  status: 'unchecked',
  remoteBackend: 'worker-daemon',
  workerDiscoveryPath: '/srv/worker/discovery.json',
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function deps(): WorkerHostDeps {
  return {
    readRemoteFile: vi.fn(async (_host, path) =>
      path.endsWith('discovery.json')
        ? JSON.stringify({ url: 'http://127.0.0.1:42000', token_file: '/srv/worker/daemon-token' })
        : 'test-token-only-in-memory',
    ),
    allocateLocalPort: vi.fn(async () => 41000),
    startTunnel: vi.fn(async () => ({ isAlive: () => true, stop: vi.fn(async () => {}) })),
    fetchImpl: vi.fn(async () => json({ engine: { version: '1', devices: [] } })),
  }
}
afterEach(async () => {
  await stopAllWorkerHostTunnels()
  setMemoryWorkerToken(profile.id, null)
})
describe('remote worker', () => {
  it('accepts bounded relative LoRA names and rejects traversal and platform paths', () => {
    expect(isWorkerLoraId('styles/example.safetensors')).toBe(true)
    for (const value of ['../a.safetensors', '/a.safetensors', 'C:/a.safetensors', 'a\\b.safetensors', 'nul.safetensors', '.safetensors'])
      expect(isWorkerLoraId(value)).toBe(false)
    const rows = parseWorkerSelection([{ id: 'styles/example.safetensors', strength: 0.7 }])
    expect(rows[0].path).toBe('styles/example.safetensors')
    expect(() => parseWorkerSelection([{ id: 'a.safetensors', strength: 3 }])).toThrow()
    expect(() => parseWorkerSelection([{ id: 'a.safetensors' }, { id: 'a.safetensors' }])).toThrow()
  })
  it('validates POSIX and Windows discovery paths without shell expansion', () => {
    expect(validateWorkerRemotePath('C:\\Worker Data\\discovery.json').command).toBe('type "C:\\Worker Data\\discovery.json"')
    expect(validateWorkerRemotePath('/srv/worker/discovery.json').expectedTokenPath).toBe('/srv/worker/daemon-token')
    for (const value of ['relative.json', '/srv/../token', '/srv/$HOME/token', 'C:\\worker&whoami'])
      expect(() => validateWorkerRemotePath(value)).toThrow()
  })
  it('requires a memory token and prevents credential forwarding by redirects', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }))
    await expect(requestWorkerDaemon(profile, '/v1/capabilities', { fetchImpl })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
    setMemoryWorkerToken(profile.id, 'test-token-only-in-memory')
    await requestWorkerDaemon(profile, '/v1/capabilities', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({ authorization: 'Bearer test-token-only-in-memory' }),
      }),
    )
  })
  it('validates inventories and reauthorizes selections against registration', async () => {
    setMemoryWorkerToken(profile.id, 'test-token-only-in-memory')
    const fetchImpl = vi.fn(async () => json({ items: [{ id: 'styles/a.safetensors', bytes: 12, extra: '/private/path' }] }))
    expect(await listRemoteWorkerLoras(profile, false, fetchImpl)).toEqual({
      items: [{ id: 'styles/a.safetensors', name: 'a.safetensors', sizeBytes: 12, registered: true }],
    })
    expect(await resolveRemoteWorkerAdapters(profile, [{ id: 'styles/a.safetensors', strength: 1 }], fetchImpl)).toEqual([
      { path: 'styles/a.safetensors', strength: 1 },
    ])
    await expect(resolveRemoteWorkerAdapters(profile, [{ id: 'missing.safetensors' }], fetchImpl)).rejects.toThrow()
    await expect(
      listRemoteWorkerLoras(
        profile,
        false,
        vi.fn(async () => json({ items: [{ id: '../a.safetensors' }] })),
      ),
    ).rejects.toThrow()
    await expect(
      changeRemoteWorkerLora(
        profile,
        'a.safetensors',
        'register',
        vi.fn(async () => json({ id: 'other.safetensors', registered: true })),
      ),
    ).rejects.toThrow()
  })
  it('connects once, exposes no token in profiles, and clears credentials on disconnect', async () => {
    const dependencies = deps()
    await Promise.all([connectWorkerHost(host, { deps: dependencies }), connectWorkerHost(host, { deps: dependencies })])
    expect(dependencies.startTunnel).toHaveBeenCalledTimes(1)
    expect(listActiveWorkerProfiles()).toEqual([expect.objectContaining({ id: 'worker-test', workflow: 'default' })])
    expect(JSON.stringify(listActiveWorkerProfiles())).not.toContain('test-token-only-in-memory')
    expect(getMemoryWorkerToken('worker-test')).toBeTruthy()
    await disconnectWorkerHost(host.id)
    expect(getMemoryWorkerToken('worker-test')).toBeUndefined()
    expect(listActiveWorkerProfiles()).toEqual([])
  })
  it('asks the daemon what a run can use instead of assuming it, and keeps picture inputs off', async () => {
    const dependencies = deps()
    dependencies.fetchImpl = vi.fn(async () =>
      json({
        engine: { version: '1', devices: [] },
        features: { lora: true, samplers: true, image_input: true },
        values: { sampler: ['euler'] },
      }),
    )
    await connectWorkerHost(host, { deps: dependencies })
    expect(await workerEngineFeatures(host)).toEqual({
      preview: false,
      imageInput: false,
      control: false,
      references: false,
      hires: false,
      samplers: true,
      lora: true,
      values: { sampler: ['euler'] },
    })
    await disconnectWorkerHost(host.id)
    await connectWorkerHost(host, { deps: deps() })
    expect(await workerEngineFeatures(host)).toMatchObject({ lora: false, samplers: false, values: {} })
  })

  it('rejects discovery redirects and token files outside the discovery directory', async () => {
    for (const discovery of [
      { url: 'http://worker.example:42000', token_file: '/srv/worker/daemon-token' },
      { url: 'http://127.0.0.1:42000', token_file: '/etc/daemon-token' },
    ]) {
      const dependencies = deps()
      dependencies.readRemoteFile = vi.fn(async () => JSON.stringify(discovery))
      await expect(connectWorkerHost(host, { deps: dependencies })).rejects.toThrow()
      expect(dependencies.startTunnel).not.toHaveBeenCalled()
    }
  })
  it('maps generic job requests and cancels timed-out remote work', async () => {
    setMemoryWorkerToken(profile.id, 'test-token-only-in-memory')
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === 'POST' ? json({ id: 'remote-job', status: 'queued' }) : json({ id: 'remote-job', status: 'running' }),
    )
    const onEvent = vi.fn()
    await expect(
      runRemoteWorkerJob({
        profile,
        jobId: 'local-job',
        params: { prompt: 'test', negativePrompt: '', width: 64, height: 64, steps: 2, cfg: 3, seed: 1, profile: 'base' },
        output: 'unused.png',
        fetchImpl,
        deadlineMs: 10,
        pollMs: 1,
        onEvent,
      }),
    ).rejects.toThrow('超时')
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/v1/jobs/remote-job/cancel'),
      expect.objectContaining({ method: 'POST' }),
    )
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(request.profile).toBe('default')
    expect(request.request_id).toBe('local-job')
    expect(await cancelRemoteWorkerJob('local-job')).toBe(false)
  })
  it('reports remote cancellation without downloading an image', async () => {
    setMemoryWorkerToken(profile.id, 'test-token-only-in-memory')
    const fetchImpl = vi.fn(async () => json({ id: 'remote-job', status: 'cancelled' }))
    const onEvent = vi.fn()
    expect(
      await runRemoteWorkerJob({
        profile,
        jobId: 'cancelled-job',
        params: { prompt: 'test', negativePrompt: '', width: 64, height: 64, steps: 2, cfg: 3, seed: 1, profile: 'base' },
        output: 'unused.png',
        fetchImpl,
        onEvent,
      }),
    ).toBe(130)
    expect(onEvent).toHaveBeenCalledWith({ type: 'canceled', at_stage: 'idle' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('invalidates an in-flight connection when disconnected', async () => {
    const dependencies = deps()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const stop = vi.fn(async () => {})
    dependencies.startTunnel = vi.fn(async () => {
      await gate
      return { isAlive: () => true, stop }
    })
    const pending = connectWorkerHost(host, { deps: dependencies })
    await vi.waitFor(() => expect(dependencies.startTunnel).toHaveBeenCalled())
    await disconnectWorkerHost(host.id)
    release()
    await expect(pending).rejects.toThrow()
    expect(stop).toHaveBeenCalled()
    expect(listActiveWorkerProfiles()).toEqual([])
  })
})
