import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { CLIENT_TOOL_TIMEOUT_SEC, type BridgeLaunch, type ManagedClientId, type McpClientStatus } from '@shared/mcpClients'
import { childEnv, cliLaunch, findCli } from '../lib/cliDiscovery'
import { isNetworkPath } from '../lib/localPath'
export type { McpClientId, McpClientStatus } from '@shared/mcpClients'
import { paths } from '../lib/paths'
import { run, type RunResult } from '../lib/run'
import { getMcpServerState } from './server'

/**
 * Registers MossStudio's stdio MCP bridge (`tools/mcp/mossstudio-mcp-stdio.mjs`,
 * copied to `<dataRoot>/mcp/`) with Codex and Claude Code through their own
 * CLIs (`codex mcp add/remove`, `claude mcp add-json/remove`), run without a
 * shell. MossStudio never rewrites their config files, except one line Codex's
 * CLI cannot set: the tool timeout, which must outlast an approval.
 *
 * What was registered is remembered in `<dataRoot>/mcp/clients.json`, so a new
 * app version (another `app-<version>` folder) registers again with its own
 * path, and uninstalling removes exactly what MossStudio added.
 */

/** MCP server name MossStudio registers under in each client. */
export const MCP_SERVER_NAME = 'mossstudio'
const CLI_TIMEOUT_MS = 20_000

export interface McpClientInstallerOptions {
  homeDir?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  stdioBridgePath?: string
  discoveryPath?: string
  execPath?: string
  /** Where registrations are remembered; defaults to `<dataRoot>/mcp/clients.json`. */
  recordPath?: string
  /** How long one CLI call may take; uninstalling uses less. */
  cliTimeoutMs?: number
  /** Runs a CLI without a shell (tests replace it). */
  runCli?: (command: string, args: string[]) => Promise<RunResult>
}

interface Resolved {
  home: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  stdioBridgePath: string
  discoveryPath: string
  execPath: string
  recordPath: string
  runCli: (command: string, args: string[]) => Promise<RunResult>
}

type Records = Partial<Record<ManagedClientId, BridgeLaunch>>

function resolve(options: McpClientInstallerOptions = {}): Resolved {
  const state = options.stdioBridgePath !== undefined && options.discoveryPath !== undefined ? null : getMcpServerState(false)
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  return {
    home: options.homeDir ?? homedir(),
    env,
    platform,
    stdioBridgePath: options.stdioBridgePath ?? state!.stdioBridgePath,
    discoveryPath: options.discoveryPath ?? state!.discoveryPath,
    execPath: options.execPath ?? process.execPath,
    recordPath: options.recordPath ?? join(paths.mcpDir(), 'clients.json'),
    runCli:
      options.runCli ??
      (async (command, args) => {
        const launch = cliLaunch(command, args, { platform, env, home: options.homeDir }, options.execPath)
        // A Windows shim may resolve to this app's own binary, which runs the script only as node.
        return run(launch.command, launch.args, {
          timeoutMs: options.cliTimeoutMs ?? CLI_TIMEOUT_MS,
          env: childEnv(launch.command, env, options.execPath),
        })
      }),
  }
}

export function bridgeLaunch(options: McpClientInstallerOptions = {}): BridgeLaunch {
  const resolved = resolve(options)
  return launchOf(resolved)
}

function launchOf(resolved: Resolved): BridgeLaunch {
  const env = { MOSSSTUDIO_MCP_DISCOVERY: resolved.discoveryPath }
  // Electron runs a script as node only with this variable, and only this app's binary needs it.
  const node = findCli('node', resolved)
  if (node.kind === 'ready') return { command: node.path, args: [resolved.stdioBridgePath], env }
  return { command: resolved.execPath, args: [resolved.stdioBridgePath], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
}

function readRecords(path: string): Records {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Records) : {}
  } catch {
    // None yet, or unreadable: nothing is known to be registered.
    return {}
  }
}

function writeRecords(path: string, records: Records): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8')
  renameSync(tmp, path)
}

const CLIENTS: Record<ManagedClientId, { label: string; cli: string }> = {
  codex: { label: 'Codex', cli: 'codex' },
  'claude-code': { label: 'Claude Code', cli: 'claude' },
}

function codexConfigPath(resolved: Resolved): string {
  return join(resolved.env.CODEX_HOME?.trim() || join(resolved.home, '.codex'), 'config.toml')
}

function claudeConfigPath(resolved: Resolved): string {
  return join(resolved.env.CLAUDE_CONFIG_DIR || resolved.home, '.claude.json')
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Only a confirmed missing server permits an add; a broken config or a failed lookup is not absence. */
async function readEntry(
  id: ManagedClientId,
  cli: string,
  r: Resolved,
): Promise<{ transport: unknown; disabled?: boolean; restricted?: boolean } | undefined> {
  if (id === 'codex') {
    const result = await r.runCli(cli, ['mcp', 'get', MCP_SERVER_NAME, '--json'])
    if (result.code === 1 && !result.timedOut && /^Error: No MCP server named 'mossstudio' found\.\s*$/m.test(result.stderr))
      return undefined
    if (result.code !== 0) throw new Error('Codex 未能读取 MCP 配置，请在终端检查 codex mcp get mossstudio --json')
    const entry: unknown = JSON.parse(result.stdout)
    if (!object(entry) || entry.name !== MCP_SERVER_NAME || !object(entry.transport)) throw new Error('Codex 返回了无法识别的 MCP 配置')
    // An empty Codex allowlist denies every tool; an empty denylist denies none.
    const restricted = Array.isArray(entry.enabled_tools) || (Array.isArray(entry.disabled_tools) && entry.disabled_tools.length > 0)
    return { transport: entry.transport, disabled: entry.enabled === false, restricted }
  }
  let config: unknown
  try {
    config = JSON.parse(readFileSync(claudeConfigPath(r), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('无法读取 Claude Code 用户配置，请检查文件格式和权限')
  }
  if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) throw new Error('Claude Code 用户配置格式不正确')
  const transport = config.mcpServers?.[MCP_SERVER_NAME]
  return transport === undefined ? undefined : { transport }
}

/** The bridge this instance runs, or the bundled copy a record kept when copying it to `<dataRoot>/mcp/` had failed. */
function ownBridge(args: unknown, r: Resolved): boolean {
  if (isDeepStrictEqual(args, [r.stdioBridgePath])) return true
  const [script] = Array.isArray(args) && args.length === 1 ? (args as unknown[]) : []
  return typeof script === 'string' && isAbsolute(script) && basename(script) === basename(r.stdioBridgePath)
}

function matches(entry: unknown, launch: BridgeLaunch | undefined, r: Resolved): boolean {
  return (
    !!launch &&
    typeof launch.command === 'string' &&
    (launch.command === 'node' || isAbsolute(launch.command)) &&
    ownBridge(launch.args, r) &&
    launch.env?.MOSSSTUDIO_MCP_DISCOVERY === r.discoveryPath &&
    object(entry) &&
    (entry.type === undefined || entry.type === 'stdio') &&
    entry.command === launch.command &&
    isDeepStrictEqual(entry.args, launch.args) &&
    isDeepStrictEqual(entry.env, launch.env)
  )
}

async function inspect(id: ManagedClientId, r: Resolved) {
  const { label, cli: name } = CLIENTS[id]
  const cli = findCli(name, r)
  const record = readRecords(r.recordPath)[id]
  const status: McpClientStatus = {
    id,
    label,
    configPath: id === 'codex' ? codexConfigPath(r) : claudeConfigPath(r),
    state: 'not_found',
    installMode: 'copy-only',
    detail: '',
  }
  if (cli.kind !== 'ready') {
    status.state = cli.kind === 'unsupported' ? 'unsupported' : 'not_found'
    status.detail = cli.kind === 'unsupported' ? `${name} 不可执行或不是支持的启动脚本` : `没有找到 ${name} 命令`
    if (record) status.detail += '；清理记录已保留，请恢复命令后再卸载'
    return { status, cli: null }
  }
  status.installMode = 'auto'
  try {
    const entry = await readEntry(id, cli.path, r)
    if (!entry) status.state = 'not_configured'
    else if (matches(entry.transport, launchOf(r), r)) status.state = 'configured'
    else if (matches(entry.transport, record, r)) status.state = 'needs_refresh'
    else status.state = 'conflict'
    if (status.state === 'conflict') status.detail = '同名 mossstudio 配置不属于本实例，请在客户端检查；不会覆盖或卸载。'
    else if (entry?.disabled || entry?.restricted) {
      status.state = 'custom_policy'
      const policy = [entry.disabled && '已禁用此服务', entry.restricted && '已限制可用工具'].filter(Boolean).join('，')
      status.detail = `Codex ${policy}，未自动覆盖。`
    }
  } catch (err) {
    status.state = 'unknown'
    status.detail = err instanceof SyntaxError ? '客户端返回的 MCP 配置不是有效的 JSON' : String(err instanceof Error ? err.message : err)
  }
  return { status, cli: cli.path }
}

function dshStatus(r: Resolved): McpClientStatus {
  const home = r.env.DSH_HOME?.trim() || join(r.home, '.dsh')
  let state: McpClientStatus['state'] = 'not_found'
  try {
    if (isAbsolute(home) && !isNetworkPath(home) && statSync(home, { throwIfNoEntry: false })?.isDirectory()) state = 'detected'
  } catch {
    state = 'unknown'
  } // No DSH settings or credentials are opened.
  return {
    id: 'dsh',
    label: 'DeepSeek Harness 桌面版',
    configPath: home,
    state,
    installMode: 'copy-only',
    detail: '复制后，在 DSH 中手动填写并保存 MCP 客户端配置。',
  }
}

export async function getMcpClientsStatus(options: McpClientInstallerOptions = {}): Promise<McpClientStatus[]> {
  const r = resolve(options)
  return [...(await Promise.all((['codex', 'claude-code'] as const).map(async (id) => (await inspect(id, r)).status))), dshStatus(r)]
}

function failure(client: string, result: RunResult): Error {
  return new Error(`${client} ${result.timedOut ? '超时' : `失败（退出码 ${result.code}）`}，请在终端检查客户端后重试`)
}

async function change(
  id: ManagedClientId,
  r: Resolved,
  action: 'install' | 'reconnect' | 'refresh' | 'uninstall',
): Promise<McpClientStatus> {
  const { cli, status } = await inspect(id, r)
  if (!cli || status.state === 'conflict' || status.state === 'unknown') throw new Error(status.detail)
  const remove = action === 'uninstall'
  if (action === 'refresh' && status.state !== 'needs_refresh') return status
  if (status.state === 'custom_policy' && action === 'install') throw new Error(`${status.detail} 请确认是否重新连接。`)
  const launch = launchOf(r)
  if (status.state === 'needs_refresh' || status.state === 'custom_policy' || (remove && status.state === 'configured')) {
    const args = ['mcp', 'remove', ...(id === 'claude-code' ? ['--scope', 'user'] : []), MCP_SERVER_NAME]
    const res = await r.runCli(cli, args)
    if (res.code !== 0) throw failure(`${CLIENTS[id].cli} mcp remove`, res)
  }
  if (!remove && status.state !== 'configured') {
    const env = Object.entries(launch.env).flatMap(([key, value]) => ['--env', `${key}=${value}`])
    const args =
      id === 'codex'
        ? ['mcp', 'add', MCP_SERVER_NAME, ...env, '--', launch.command, ...launch.args]
        : ['mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify({ type: 'stdio', ...launch })]
    const res = await r.runCli(cli, args)
    if (res.code !== 0) throw failure(`${CLIENTS[id].cli} mcp ${args[1]}`, res)
  }
  const next = (await inspect(id, r)).status
  if (next.state !== (remove ? 'not_configured' : 'configured')) throw new Error(next.detail || '未能确认配置结果，请重新检测')
  const records = readRecords(r.recordPath)
  if (remove) delete records[id]
  else records[id] = launch
  writeRecords(r.recordPath, records)
  if (!remove && id === 'codex' && !setCodexToolTimeout(codexConfigPath(r), CLIENT_TOOL_TIMEOUT_SEC))
    throw new Error(`Codex 已配置，请在客户端将工具超时设置为 ${CLIENT_TOOL_TIMEOUT_SEC} 秒`)
  return next
}

// Startup refresh and IPC mutations must inspect the state left by the preceding operation.
let tail: Promise<unknown> = Promise.resolve()
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work)
  tail = next.catch(() => undefined)
  return next
}

export function installMcpClient(id: ManagedClientId, options: McpClientInstallerOptions & { resetPolicy?: true } = {}) {
  return enqueue(() => change(id, resolve(options), options.resetPolicy === true ? 'reconnect' : 'install'))
}

export function uninstallMcpClient(id: ManagedClientId, options: McpClientInstallerOptions = {}) {
  return enqueue(() => change(id, resolve(options), 'uninstall'))
}

export async function refreshMcpClientRegistrations(options: McpClientInstallerOptions = {}): Promise<void> {
  const r = resolve(options)
  for (const id of Object.keys(readRecords(r.recordPath)) as ManagedClientId[]) {
    if (Object.hasOwn(CLIENTS, id)) await enqueue(() => change(id, r, 'refresh')).catch((err) => console.warn('[mcp]', String(err)))
  }
}

export async function uninstallRecordedMcpClients(dataRoot: string, options: McpClientInstallerOptions = {}): Promise<void> {
  const recordPath = join(dataRoot, 'mcp', 'clients.json')
  for (const id of Object.keys(readRecords(recordPath)) as ManagedClientId[]) {
    if (Object.hasOwn(CLIENTS, id))
      await uninstallMcpClient(id, {
        cliTimeoutMs: 8000,
        stdioBridgePath: join(dataRoot, 'mcp', 'mossstudio-mcp-stdio.mjs'),
        discoveryPath: join(dataRoot, 'mcp-server.json'),
        ...options,
        recordPath,
      }).catch((err) => console.warn('[mcp]', String(err)))
  }
}

/* Codex: the tool timeout. `codex mcp add` has no option for it, so one line is added to the table Codex just wrote. */

/**
 * A TOML table header (`[a.b]`, quoted keys allowed) as its key path, or null
 * for any other line (array items, inline tables, comments).
 */
export function parseTomlTableHeader(line: string): string[] | null {
  const match = /^\s*\[(?!\[)(.+?)\]\s*(?:#.*)?$/.exec(line)
  if (!match) return null
  const parts: string[] = []
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y
  const inner = match[1]!
  let index = 0
  while (index < inner.length) {
    pattern.lastIndex = index
    const part = pattern.exec(inner)
    if (!part) return null
    parts.push(part[1] ?? part[2] ?? part[3]!)
    index = pattern.lastIndex
    if (part[4] === '') break
  }
  return index === inner.length ? parts : null
}

/** Whether a line defines `mossstudio` some way other than its own `[mcp_servers.mossstudio]` table. */
function otherMossDefinition(line: string, table: string[] | null): boolean {
  const key = /^\s*([A-Za-z0-9_."'-]+)\s*=/.exec(line)?.[1]?.replace(/["']/g, '')
  if (!key) return false
  const full = [...(table ?? []), ...key.split('.')]
  if (full.length === 1 && full[0] === 'mcp_servers') return line.includes(MCP_SERVER_NAME)
  return full[0] === 'mcp_servers' && full.length >= 2 && full[1] === MCP_SERVER_NAME && (table ?? []).length < 2
}

/**
 * Sets `tool_timeout_sec` in `[mcp_servers.mossstudio]`, through a symlink to
 * the real file, keeping its permissions, with one backup next to it. Does
 * nothing and returns false when the file does not have exactly one such table
 * in the plain form Codex writes (an inline or dotted definition, say).
 */
export function setCodexToolTimeout(configPath: string, seconds: number): boolean {
  let real: string
  let text: string
  try {
    real = realpathSync(configPath)
    text = readFileSync(real, 'utf8')
  } catch {
    // Codex did not write a file where expected: nothing to adjust.
    return false
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  let table: string[] | null = null
  let header = -1
  let headers = 0
  let existing = -1
  for (const [index, line] of lines.entries()) {
    const parsed = parseTomlTableHeader(line)
    if (parsed) {
      table = parsed
      if (parsed.length === 2 && parsed[0] === 'mcp_servers' && parsed[1] === MCP_SERVER_NAME) {
        header = index
        headers += 1
      }
      continue
    }
    if (otherMossDefinition(line, table)) return false
    const inOurs = table?.length === 2 && table[0] === 'mcp_servers' && table[1] === MCP_SERVER_NAME
    if (inOurs && /^\s*tool_timeout_sec\s*=/.test(line)) existing = index
  }
  if (headers !== 1) return false
  const setting = `tool_timeout_sec = ${seconds}`
  if (existing >= 0) {
    if (lines[existing]!.trim() === setting) return true
    lines[existing] = setting
  } else {
    lines.splice(header + 1, 0, setting)
  }
  const mode = statSync(real).mode & 0o777
  const backup = `${real}.mossstudio-backup`
  copyFileSync(real, backup)
  chmodSync(backup, mode)
  const tmp = `${real}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, lines.join(eol), { encoding: 'utf8', mode })
    chmodSync(tmp, mode)
    renameSync(tmp, real)
  } finally {
    rmSync(tmp, { force: true })
  }
  return true
}
