import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import type { RemoteWorkerProfile } from '@shared/remoteWorker'
import type { ComputeDevice, EngineFeatures, RemoteEngineInfo, Settings, TrainingHost } from '@shared/types'
import { codedError } from '../lib/codedError'
import { run } from '../lib/run'
import { requestWorkerDaemon, setMemoryWorkerToken } from './remoteWorker'
import { posixQuote, sshCommand, sshEnv, sshExec, sshTunnelArgs } from './ssh'
import { trustUnknownHost } from './sshHostKeys'

export type WorkerHostConfig = TrainingHost & {
  remoteBackend?: 'moss-ssh' | 'worker-daemon'
  workerDiscoveryPath?: string
  workerProviderId?: string
  workerWorkflow?: string
}
export interface ValidatedWorkerPath {
  path: string
  platform: 'windows' | 'posix'
  command: string
  dirPath: string
  expectedTokenPath: string
}
export interface TunnelHandle {
  pid?: number
  isAlive: () => boolean
  stop: () => Promise<void>
}
export interface WorkerHostDeps {
  readRemoteFile: (host: WorkerHostConfig, remotePath: string) => Promise<string>
  allocateLocalPort: () => Promise<number>
  startTunnel: (host: WorkerHostConfig, localPort: number, remotePort: number) => Promise<TunnelHandle>
  fetchImpl: typeof fetch
}
interface Capabilities {
  engineVersion?: string
  devices: Array<{ index: number; name: string; totalBytes?: number }>
  /** What the daemon says it does (`features` in `/v1/capabilities`); anything it does not name is off. */
  features: { lora: boolean; samplers: boolean }
  /** Accepted names per enum parameter (`values`), as the engine's own `hello` gives them. */
  values: Record<string, string[]>
}
interface Session {
  profile: RemoteWorkerProfile
  signature: string
  tunnel: TunnelHandle
  capabilities: Capabilities
  checkedAt: string
}
const sessions = new Map<string, Session>()
const inflight = new Map<string, { signature: string; promise: Promise<RemoteWorkerProfile> }>()
const epochs = new Map<string, number>()
/** Worker hosts sit under 远程主机 and have their own switch in 设置 › 功能; off, they are hidden everywhere. */
export function workerHostsOn(settings: Pick<Settings, 'remoteHostsEnabled' | 'workerHostsEnabled'>): boolean {
  return settings.remoteHostsEnabled === true && settings.workerHostsEnabled === true
}
export function isWorkerDaemonHost(
  host?: Pick<WorkerHostConfig, 'kind' | 'remoteBackend'> | null,
): host is WorkerHostConfig & { kind: 'ssh'; remoteBackend: 'worker-daemon' } {
  return host?.kind === 'ssh' && host.remoteBackend === 'worker-daemon'
}
export function workerHostProviderId(host: Pick<WorkerHostConfig, 'id' | 'workerProviderId'>): string {
  const custom = host.workerProviderId?.trim()
  if (custom && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(custom)) return custom
  return `worker-${host.id}`
}
export function validateWorkerRemotePath(rawPath: string): ValidatedWorkerPath {
  const value = rawPath.trim()
  if (
    !value ||
    value.length > 4096 ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    /["'`$&|;<>()*?{}[\]!~%]/.test(value) ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)
  )
    throw codedError('E_WORKER_PATH', '请填写安全的远端绝对路径，不要使用变量或上级目录')
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    if (value.slice(2).includes(':')) throw codedError('E_WORKER_PATH', '远端路径包含非法冒号')
    const path = value.replace(/\//g, '\\')
    const dirPath = path.slice(0, path.lastIndexOf('\\')) || path.slice(0, 3)
    return {
      path,
      platform: 'windows',
      command: `type "${path}"`,
      dirPath,
      expectedTokenPath: `${dirPath.replace(/\\$/, '')}\\daemon-token`,
    }
  }
  if (value.startsWith('/') && !/[\\:]/.test(value)) {
    const path = value.replace(/\/+/g, '/')
    const dirPath = path.slice(0, path.lastIndexOf('/')) || '/'
    return {
      path,
      platform: 'posix',
      command: `cat -- ${posixQuote(path)}`,
      dirPath,
      expectedTokenPath: `${dirPath === '/' ? '' : dirPath}/daemon-token`,
    }
  }
  throw codedError('E_WORKER_PATH', '请填写 Windows 或 Linux 远端主机上的绝对路径')
}
async function readRemoteFile(host: WorkerHostConfig, remotePath: string): Promise<string> {
  const info = validateWorkerRemotePath(remotePath)
  const execute = () => {
    if (info.platform === 'posix') return sshExec(host, info.command, 45_000)
    // Reuse the verified authentication and host-key arguments, without a POSIX shell wrapper.
    const args = sshTunnelArgs(host, 1, 1)
    return run(sshCommand(), [...args.slice(0, -4), args.at(-1)!, info.command], { timeoutMs: 45_000, env: sshEnv(host) })
  }
  let result = await execute()
  if (result.code !== 0 && (await trustUnknownHost(host, new Error(result.stderr)))) result = await execute()
  if (result.code !== 0) throw codedError('E_WORKER_SSH', '读取远端文件失败，请检查 SSH 连接和路径')
  if (result.stdout.length > 64 * 1024) throw codedError('E_WORKER_DISCOVERY', '远端发现文件超过大小限制')
  return result.stdout
}
async function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : port ? resolve(port) : reject(codedError('E_WORKER_TUNNEL', '无法分配本地端口'))))
    })
  })
}
async function startTunnel(host: WorkerHostConfig, localPort: number, remotePort: number): Promise<TunnelHandle> {
  const args = sshTunnelArgs(host, localPort, remotePort)
  const child = spawn(sshCommand(), [...args.slice(0, -1), '-o', 'ExitOnForwardFailure=yes', args.at(-1)!], {
    env: { ...process.env, ...sshEnv(host) },
    stdio: 'ignore',
    windowsHide: true,
  })
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  child.once('error', () => {
    exited = true
  })
  return {
    pid: child.pid,
    isAlive: () => !exited && child.exitCode === null && !child.killed,
    stop: async () => {
      if (exited || child.exitCode !== null) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 1500)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        child.kill()
      })
    },
  }
}
function parseCapabilities(raw: unknown): Capabilities {
  if (!raw || typeof raw !== 'object' || !('engine' in raw) || !raw.engine || typeof raw.engine !== 'object')
    throw codedError('E_WORKER_RESPONSE', '远端能力信息无效')
  const engine = raw.engine as Record<string, unknown>
  const devices = Array.isArray(engine.devices) ? engine.devices : []
  const features = 'features' in raw && raw.features && typeof raw.features === 'object' ? (raw.features as Record<string, unknown>) : {}
  const rawValues = 'values' in raw && raw.values && typeof raw.values === 'object' ? (raw.values as Record<string, unknown>) : {}
  const values = Object.fromEntries(
    Object.entries(rawValues)
      .slice(0, 16)
      .flatMap(([key, list]) =>
        /^[a-z_]{1,32}$/.test(key) && Array.isArray(list)
          ? [[key, list.filter((item): item is string => typeof item === 'string' && item.length <= 64).slice(0, 64)]]
          : [],
      ),
  )
  return {
    features: { lora: features.lora === true, samplers: features.samplers === true },
    values,
    engineVersion: typeof engine.version === 'string' ? engine.version.slice(0, 128) : undefined,
    devices: devices.slice(0, 64).flatMap((row: unknown, index) => {
      if (!row || typeof row !== 'object' || !('name' in row) || typeof row.name !== 'string') return []
      const value = row as Record<string, unknown>
      return [
        {
          index: typeof value.index === 'number' && Number.isSafeInteger(value.index) && value.index >= 0 ? value.index : index,
          name: row.name.slice(0, 256),
          totalBytes:
            typeof value.total_memory_bytes === 'number' && Number.isSafeInteger(value.total_memory_bytes) && value.total_memory_bytes >= 0
              ? value.total_memory_bytes
              : undefined,
        },
      ]
    }),
  }
}
export async function disconnectWorkerHost(hostId: string): Promise<void> {
  epochs.set(hostId, (epochs.get(hostId) ?? 0) + 1)
  inflight.delete(hostId)
  const session = sessions.get(hostId)
  sessions.delete(hostId)
  if (session) {
    setMemoryWorkerToken(session.profile.id, null)
    await session.tunnel.stop()
  }
}
export async function stopAllWorkerHostTunnels(): Promise<void> {
  await Promise.all([...new Set([...sessions.keys(), ...inflight.keys()])].map(disconnectWorkerHost))
}
export function listActiveWorkerProfiles(): RemoteWorkerProfile[] {
  return [...sessions.values()].filter((session) => session.tunnel.isAlive()).map((session) => ({ ...session.profile }))
}
export function workerHostProfile(host: WorkerHostConfig): RemoteWorkerProfile {
  const profile = listActiveWorkerProfiles().find((item) => item.hostId === host.id)
  if (!profile) throw codedError('E_WORKER_OFFLINE', '请先连接远程主机')
  return profile
}
export async function connectWorkerHost(
  host: WorkerHostConfig,
  options: { forceReconnect?: boolean; deps?: Partial<WorkerHostDeps> } = {},
): Promise<RemoteWorkerProfile> {
  if (!isWorkerDaemonHost(host)) throw codedError('E_WORKER_CONFIG', '这台主机不是 Worker 服务')
  const signature = JSON.stringify([
    host.host,
    host.port,
    host.user,
    host.authMethod,
    host.identityFile,
    host.workerDiscoveryPath,
    host.workerWorkflow,
    workerHostProviderId(host),
  ])
  const existing = sessions.get(host.id)
  if (existing && !options.forceReconnect && existing.signature === signature && existing.tunnel.isAlive()) return { ...existing.profile }
  const running = inflight.get(host.id)
  if (running && !options.forceReconnect && running.signature === signature) return running.promise
  if (existing || running) await disconnectWorkerHost(host.id)
  const deps = { readRemoteFile, allocateLocalPort, startTunnel, fetchImpl: fetch, ...options.deps }
  const epoch = epochs.get(host.id) ?? 0
  const promise = (async (): Promise<RemoteWorkerProfile> => {
    const path = validateWorkerRemotePath(host.workerDiscoveryPath ?? '')
    let discovery: unknown
    try {
      discovery = JSON.parse(await deps.readRemoteFile(host, path.path))
    } catch {
      throw codedError('E_WORKER_DISCOVERY', '无法读取有效的远端发现文件')
    }
    if (
      !discovery ||
      typeof discovery !== 'object' ||
      !('url' in discovery) ||
      typeof discovery.url !== 'string' ||
      !('token_file' in discovery) ||
      typeof discovery.token_file !== 'string'
    )
      throw codedError('E_WORKER_DISCOVERY', '远端发现文件缺少地址或令牌路径')
    let url: URL
    try {
      url = new URL(discovery.url)
    } catch {
      throw codedError('E_WORKER_DISCOVERY', '远端发现地址无效')
    }
    const remotePort = Number(url.port)
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !Number.isInteger(remotePort) ||
      remotePort < 1 ||
      remotePort > 65535
    )
      throw codedError('E_WORKER_DISCOVERY', '远端服务必须绑定回环地址和有效端口')
    const tokenPath = validateWorkerRemotePath(discovery.token_file)
    const compare = (value: string) => (path.platform === 'windows' ? value.toLowerCase() : value)
    if (tokenPath.platform !== path.platform || compare(tokenPath.path) !== compare(path.expectedTokenPath))
      throw codedError('E_WORKER_DISCOVERY', '令牌文件必须是发现文件同目录的 daemon-token')
    const token = (await deps.readRemoteFile(host, tokenPath.path)).trim()
    if (token.length < 16 || token.length > 4096 || /[^\x21-\x7e]/.test(token)) throw codedError('E_WORKER_TOKEN', 'Worker 服务的密钥无效')
    if ((epochs.get(host.id) ?? 0) !== epoch) throw codedError('E_WORKER_CANCELLED', '连接已取消')
    const localPort = await deps.allocateLocalPort()
    const tunnel = await deps.startTunnel(host, localPort, remotePort)
    const profile: RemoteWorkerProfile = {
      id: workerHostProviderId(host),
      kind: 'worker-daemon',
      label: host.name?.trim() || '远程算力机',
      hostId: host.id,
      baseUrl: `http://127.0.0.1:${localPort}`,
      workflow: host.workerWorkflow?.trim() || 'default',
    }
    try {
      const deadline = Date.now() + 30_000
      let capabilities: Capabilities | undefined
      while (Date.now() < deadline) {
        if ((epochs.get(host.id) ?? 0) !== epoch) throw codedError('E_WORKER_CANCELLED', '连接已取消')
        if (!tunnel.isAlive()) throw codedError('E_WORKER_TUNNEL', 'SSH 隧道已退出，请检查连接')
        try {
          const response = await deps.fetchImpl(`${profile.baseUrl}/v1/capabilities`, {
            redirect: 'error',
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(3000),
          })
          if (!response.ok) throw codedError('E_WORKER_HTTP', '远端服务拒绝连接')
          const reader = response.body?.getReader()
          const chunks: Uint8Array[] = []
          let size = 0
          if (reader) {
            try {
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                size += value.byteLength
                if (size > 1024 * 1024) {
                  await reader.cancel()
                  throw codedError('E_WORKER_RESPONSE', '远端能力信息超过大小限制')
                }
                chunks.push(value)
              }
            } finally {
              reader.releaseLock()
            }
          }
          capabilities = parseCapabilities(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 180))
        }
      }
      if ((epochs.get(host.id) ?? 0) !== epoch) throw codedError('E_WORKER_CANCELLED', '连接已取消')
      if (!capabilities) throw codedError('E_WORKER_TUNNEL', '远端连接超时，请检查服务状态')
      if ([...sessions.values()].some((session) => session.profile.id === profile.id))
        throw codedError('E_WORKER_CONFIG', '远端服务标识重复，请修改主机配置')
      setMemoryWorkerToken(profile.id, token)
      sessions.set(host.id, { profile, signature, tunnel, capabilities, checkedAt: new Date().toISOString() })
      return { ...profile }
    } catch (error) {
      await tunnel.stop()
      throw error
    }
  })()
  inflight.set(host.id, { signature, promise })
  try {
    return await promise
  } finally {
    if (inflight.get(host.id)?.promise === promise) inflight.delete(host.id)
  }
}
export async function ensureWorkerHostReady(host: WorkerHostConfig): Promise<RemoteWorkerProfile> {
  return connectWorkerHost(host)
}
export async function releaseWorkerHost(host: WorkerHostConfig): Promise<{ released: boolean; state: string }> {
  const profile = await connectWorkerHost(host)
  const result = await requestWorkerDaemon<{ released?: unknown; state?: unknown }>(profile, '/v1/release', {
    method: 'POST',
    body: {},
    timeoutMs: 15_000,
  })
  return { released: result?.released === true, state: typeof result?.state === 'string' ? result.state.slice(0, 128) : 'idle' }
}
export function workerHostDevices(host: WorkerHostConfig): ComputeDevice[] {
  const session = sessions.get(host.id)
  if (!session?.tunnel.isAlive()) return []
  return session.capabilities.devices.map((gpu) => ({
    id: `${host.id}:cuda:${gpu.index}`,
    hostId: host.id,
    hostName: host.name,
    name: gpu.name,
    kind: 'cuda',
    detail: '远端显卡',
    memoryBytes: gpu.totalBytes,
    available: true,
    source: 'remote',
  }))
}
export async function probeWorkerHost(host: WorkerHostConfig, refresh = false, deps?: Partial<WorkerHostDeps>): Promise<RemoteEngineInfo> {
  try {
    await connectWorkerHost(host, { forceReconnect: refresh, deps })
    const session = sessions.get(host.id)!
    const capabilities = await requestWorkerDaemon(session.profile, '/v1/capabilities', { fetchImpl: deps?.fetchImpl, timeoutMs: 5000 })
    session.capabilities = parseCapabilities(capabilities)
    session.checkedAt = new Date().toISOString()
    return {
      online: true,
      available: true,
      path: host.workerDiscoveryPath ?? '',
      root: validateWorkerRemotePath(host.workerDiscoveryPath ?? '').dirPath,
      gpu: session.capabilities.devices.map((gpu) => gpu.name).join(' / '),
      version: session.capabilities.engineVersion,
      checkedAt: session.checkedAt,
    }
  } catch {
    await disconnectWorkerHost(host.id)
    return {
      online: false,
      available: false,
      path: host.workerDiscoveryPath ?? '',
      root: '',
      gpu: '',
      error: '远端连接失败，请检查主机配置和服务状态',
      checkedAt: new Date().toISOString(),
    }
  }
}

/**
 * What a run on a Worker host can use, as its daemon reports it. This app sends
 * a Worker text-to-image jobs only, so picture inputs, control, references,
 * 高清修复 and live previews stay off whatever the daemon says.
 */
export async function workerEngineFeatures(host: WorkerHostConfig): Promise<EngineFeatures | null> {
  try {
    await connectWorkerHost(host)
  } catch {
    // Not reachable now: nothing is known about it.
    return null
  }
  const session = sessions.get(host.id)
  if (!session) return null
  const { features, values } = session.capabilities
  return {
    preview: false,
    imageInput: false,
    control: false,
    references: false,
    hires: false,
    samplers: features.samplers,
    lora: features.lora,
    values: features.samplers ? values : {},
  }
}
