import type { ManagedHost, RemoteHostBackend, SshAuthMethod } from '@shared/types'
import { integerInRange, optionalHfEndpoint, optionalProxyUrl, requiredText } from '../../lib/settingsDraft'

/** What the 添加 SSH 主机 dialog edits. Strings throughout, as typed. */
export interface HostForm {
  id?: string
  name: string
  host: string
  user: string
  port: string
  authMethod: SshAuthMethod
  identityFile: string
  password: string
  hasPassword: boolean
  /** How the computer runs pictures: MossStudio's own engine over SSH, or a worker daemon reached through an SSH tunnel. */
  remoteBackend: RemoteHostBackend
  /** Absolute path of the worker daemon's discovery file on the remote computer. */
  workerDiscoveryPath: string
  /** Worker workflow name; empty = the daemon's default. */
  workerWorkflow: string
  trainerRoot: string
  engineRoot: string
  outputRoot: string
  modelsRoot: string
  /** Folder on the remote computer with the base model for training; empty = the host decides. */
  weightsPath: string
  downloadProxy: string
  hfEndpoint: string
  downloadConcurrency: string
  hfToken: string
  hasHfToken: boolean
  clearHfToken: boolean
}

export const REMOTE_DEFAULT_PATHS = {
  trainerRoot: '~/.mossstudio/trainer',
  engineRoot: '~/.mossstudio/engine',
  outputRoot: '~/.mossstudio/outputs',
  modelsRoot: '~/.mossstudio/models',
} as const

export function emptyHostForm(): HostForm {
  return {
    name: '',
    host: '',
    user: '',
    port: '22',
    authMethod: 'identityFile',
    identityFile: '',
    password: '',
    hasPassword: false,
    remoteBackend: 'moss-ssh',
    workerDiscoveryPath: '',
    workerWorkflow: '',
    ...REMOTE_DEFAULT_PATHS,
    weightsPath: '',
    downloadProxy: '',
    hfEndpoint: '',
    downloadConcurrency: '',
    hfToken: '',
    hasHfToken: false,
    clearHfToken: false,
  }
}

export function hostFormFrom(host: ManagedHost): HostForm {
  return {
    id: host.id,
    name: host.name,
    host: host.host ?? '',
    user: host.user ?? '',
    port: String(host.port ?? 22),
    authMethod: host.authMethod ?? 'identityFile',
    identityFile: host.identityFile ?? '',
    password: '',
    hasPassword: host.hasPassword ?? false,
    remoteBackend: host.remoteBackend ?? 'moss-ssh',
    workerDiscoveryPath: host.workerDiscoveryPath ?? '',
    workerWorkflow: host.workerWorkflow ?? '',
    trainerRoot: host.trainerRoot || REMOTE_DEFAULT_PATHS.trainerRoot,
    engineRoot: host.engineRoot ?? REMOTE_DEFAULT_PATHS.engineRoot,
    outputRoot: host.outputRoot ?? REMOTE_DEFAULT_PATHS.outputRoot,
    modelsRoot: host.modelsRoot ?? REMOTE_DEFAULT_PATHS.modelsRoot,
    weightsPath: host.weightsPath ?? '',
    downloadProxy: host.downloadProxy ?? '',
    hfEndpoint: host.hfEndpoint ?? '',
    downloadConcurrency: host.downloadConcurrency ? String(host.downloadConcurrency) : '',
    hfToken: '',
    hasHfToken: host.hasHfToken ?? false,
    clearHfToken: false,
  }
}

export type HostFormErrors = Partial<Record<keyof HostForm, string>>

/** The same rules the main process applies before it reads the file over SSH. */
export function workerDiscoveryProblem(raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return '请填写服务信息文件的完整路径'
  if (value.length > 4096 || Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return '路径太长或包含控制字符'
  if (/["'`$&|;<>()*?{}[\]!~%]/.test(value)) return '路径不能包含引号、变量或通配符'
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) return '路径不能包含上级目录 ..'
  if (/^[A-Za-z]:[\\/]/.test(value)) return value.slice(2).includes(':') ? '路径里只能有盘符后的一个冒号' : undefined
  if (value.startsWith('/')) return undefined
  return '请填写完整路径，例如 /srv/worker/discovery.json 或 C:\\worker\\discovery.json'
}

/** Field-by-field problems, shown under each field. Empty means the form can be saved. */
export function validateHostForm(form: HostForm): HostFormErrors {
  const errors: HostFormErrors = {}
  const host = requiredText('地址')(form.host)
  if (host) errors.host = host
  else if (/\s/.test(form.host.trim())) errors.host = '地址不能包含空格'
  const user = requiredText('用户名')(form.user)
  if (user) errors.user = user
  const port = integerInRange(1, 65535)(form.port)
  if (port) errors.port = port
  if (form.authMethod === 'password' && !form.password && !form.hasPassword) errors.password = '请输入 SSH 密码'
  if (/[\r\n\0]/.test(form.password)) errors.password = '密码不能包含换行'
  if (form.remoteBackend === 'worker-daemon') {
    // The daemon owns models, engine and outputs: only how to reach it matters.
    const discovery = workerDiscoveryProblem(form.workerDiscoveryPath)
    if (discovery) errors.workerDiscoveryPath = discovery
    if (form.workerWorkflow.trim().length > 120) errors.workerWorkflow = '名称太长'
    return errors
  }
  const trainerRoot = requiredText('训练器目录')(form.trainerRoot)
  if (trainerRoot) errors.trainerRoot = trainerRoot
  const proxy = optionalProxyUrl(form.downloadProxy)
  if (proxy) errors.downloadProxy = proxy
  const endpoint = optionalHfEndpoint(form.hfEndpoint)
  if (endpoint) errors.hfEndpoint = endpoint
  const concurrency = integerInRange(1, 16, { optional: true })(form.downloadConcurrency)
  if (concurrency) errors.downloadConcurrency = concurrency
  return errors
}

/** OpenSSH options that take a value, so their value is not mistaken for the destination. */
const SSH_VALUE_OPTIONS = new Set('BbcDEeFIiJLlmOopQRSWw'.split(''))

function shellWords(text: string): string[] {
  const words: string[] = []
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3] ?? '')
  return words
}

type SshLogin = Partial<Pick<HostForm, 'host' | 'user' | 'port' | 'identityFile' | 'authMethod'>>

/** `[ssh://][user@]host[:port]`; a bare IPv6 address keeps its colons. */
function destination(text: string): SshLogin | null {
  const rest = text.replace(/^ssh:\/\//i, '').replace(/\/$/, '')
  const at = rest.lastIndexOf('@')
  let host = rest.slice(at + 1)
  let port: string | undefined
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host)
  if (bracketed) [, host = '', port] = bracketed
  else if (host.split(':').length === 2) {
    ;[host = '', port] = host.split(':')
    if (!/^\d+$/.test(port ?? '')) return null
  }
  if (!host || /[\s/@]/.test(host)) return null
  return { host, ...(at > 0 ? { user: rest.slice(0, at) } : {}), ...(port ? { port } : {}) }
}

/**
 * Host, user, port and key from what a GPU rental site gives to copy, such as
 * `ssh -p 41234 root@connect.example.com`, `ssh://root@host:41234` or `root@host`. Null when the
 * text is a plain address, so typing one is left alone.
 */
export function parseSshCommand(text: string): SshLogin | null {
  const words = shellWords(text.trim())
  const [first = ''] = words
  if (!/(^|[\\/])ssh(\.exe)?$/i.test(first)) {
    return words.length === 1 && (/^ssh:\/\//i.test(first) || first.includes('@')) ? destination(first) : null
  }
  const options: SshLogin = {}
  let target: string | undefined
  for (let index = 1; index < words.length && target === undefined; index++) {
    const word = words[index]!
    if (!word.startsWith('-') || word === '-') {
      target = word
      continue
    }
    const at = [...word.slice(1)].findIndex((flag) => SSH_VALUE_OPTIONS.has(flag)) + 1
    if (at === 0) continue
    const flag = word[at]
    const value = word.slice(at + 1) || words[++index] || ''
    const [key = '', ...rest] = flag === 'o' ? value.split(/[=\s]/) : [flag ?? '', value]
    const option = rest.join('=').trim()
    if (/^(p|port)$/i.test(key)) options.port = option
    else if (/^(l|user)$/i.test(key)) options.user = option
    else if (/^(i|identityfile)$/i.test(key)) options.identityFile = option
  }
  const found = target === undefined ? null : destination(target)
  if (!found) return null
  const login = { ...options, ...found }
  if (login.port !== undefined && !/^\d+$/.test(login.port)) delete login.port
  return login.identityFile ? { ...login, authMethod: 'identityFile' } : login
}

/** The `Ipc.hostsSave` payload. Paths the save call does not take go through `hostPathsPatch`. */
export function hostSavePayload(form: HostForm): Record<string, unknown> {
  const host = form.host.trim()
  return {
    id: form.id,
    name: form.name.trim() || host,
    host,
    user: form.user.trim(),
    port: Number(form.port) || 22,
    authMethod: form.authMethod,
    identityFile: form.authMethod === 'identityFile' ? form.identityFile.trim() || undefined : undefined,
    password: form.authMethod === 'password' ? form.password || undefined : undefined,
    remoteBackend: form.remoteBackend,
    ...(form.remoteBackend === 'worker-daemon'
      ? { workerDiscoveryPath: form.workerDiscoveryPath.trim(), workerWorkflow: form.workerWorkflow.trim() || undefined }
      : {}),
    // Hidden while the worker daemon is chosen, but kept, so switching back finds them as they were.
    trainerRoot: form.trainerRoot.trim() || REMOTE_DEFAULT_PATHS.trainerRoot,
    modelsRoot: form.modelsRoot.trim() || undefined,
    weightsPath: form.weightsPath.trim() || undefined,
    downloadProxy: form.downloadProxy.trim(),
    hfEndpoint: form.hfEndpoint.trim(),
    downloadConcurrency: form.downloadConcurrency.trim() ? Number(form.downloadConcurrency) : null,
    hfToken: form.hfToken.trim() || undefined,
    clearHfToken: form.clearHfToken,
  }
}

/** Engine and output folders are saved separately (`Ipc.hostsUpdatePaths`). */
export function hostPathsPatch(id: string, form: HostForm): { id: string; engineRoot?: string; outputRoot?: string } {
  return {
    id,
    engineRoot: form.engineRoot.trim() || undefined,
    outputRoot: form.outputRoot.trim() || undefined,
  }
}
