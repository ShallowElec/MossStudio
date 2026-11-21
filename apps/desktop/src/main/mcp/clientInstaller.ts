import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { APPROVAL_WAIT_MS } from '../agentHub/approvalQueue'
import { childEnv, resolveAcpLaunch } from '../agentHub/acpDriver'
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

export type McpClientId = 'codex' | 'claude-code'

export interface McpClientStatus {
  id: McpClientId
  label: string
  /** The client's config file, for reference; MossStudio changes it only through the client's CLI. */
  configPath: string
  /** The client's CLI was found. */
  detected: boolean
  installed: boolean
  /** `copy-only`: no CLI here, so the person copies the MCP settings into the client by hand. */
  installMode: 'auto' | 'copy-only'
  detail: string
}

/** MCP server name MossStudio registers under in each client. */
export const MCP_SERVER_NAME = 'mossstudio'
/** Seconds a client waits for one tool call: longer than an approval waits, so a late approval never runs an abandoned call. */
export const CLIENT_TOOL_TIMEOUT_SEC = Math.ceil(APPROVAL_WAIT_MS / 1000) + 60
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

/** How a client starts the bridge: the person's own node when there is one, else this app running as node. */
export interface BridgeLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

type Records = Partial<Record<McpClientId, BridgeLaunch>>

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
        const launch = await resolveAcpLaunch(command, args, platform)
        // A Windows shim may resolve to this app's own binary, which runs the script only as node.
        return run(launch.command, launch.args, {
          timeoutMs: options.cliTimeoutMs ?? CLI_TIMEOUT_MS,
          env: { ...env, ...childEnv(launch.command) },
        })
      }),
  }
}

/** Pure-FS PATH scan (no child process), so a freshly installed CLI is found before it ever ran. */
export function findExecutableOnPath(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const rawPath = env.PATH ?? env.Path ?? ''
  if (!rawPath) return null
  const sep = platform === 'win32' ? ';' : delimiter
  const dirs = rawPath
    .split(sep)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
  const exts =
    platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .map((ext) => ext.trim())
          .filter(Boolean)
      : ['']
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const full = join(dir, `${name}${ext}`)
        if (existsSync(full) && statSync(full).isFile()) return full
      }
    }
  }
  return null
}

export function bridgeLaunch(options: McpClientInstallerOptions = {}): BridgeLaunch {
  const resolved = resolve(options)
  return launchOf(resolved)
}

function launchOf(resolved: Resolved): BridgeLaunch {
  const env = { MOSSSTUDIO_MCP_DISCOVERY: resolved.discoveryPath }
  // Electron runs a script as node only with this variable, and only this app's binary needs it.
  if (findExecutableOnPath(['node'], resolved.env, resolved.platform)) return { command: 'node', args: [resolved.stdioBridgePath], env }
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

const CLIENTS: Record<McpClientId, { label: string; cli: string }> = {
  codex: { label: 'Codex', cli: 'codex' },
  'claude-code': { label: 'Claude Code', cli: 'claude' },
}

function codexConfigPath(resolved: Resolved): string {
  return join(resolved.env.CODEX_HOME?.trim() || join(resolved.home, '.codex'), 'config.toml')
}

function claudeConfigPath(resolved: Resolved): string {
  return join(resolved.home, '.claude.json')
}

/** Whether Claude Code has a user-scope `mossstudio` server: read, never written, by MossStudio. */
function claudeHasServer(resolved: Resolved): boolean {
  try {
    const parsed = JSON.parse(readFileSync(claudeConfigPath(resolved), 'utf8')) as { mcpServers?: Record<string, unknown> }
    return Boolean(parsed.mcpServers && typeof parsed.mcpServers === 'object' && MCP_SERVER_NAME in parsed.mcpServers)
  } catch {
    // Missing or unreadable: not registered as far as can be told.
    return false
  }
}

async function codexHasServer(resolved: Resolved, cli: string): Promise<boolean> {
  const result = await resolved.runCli(cli, ['mcp', 'get', MCP_SERVER_NAME, '--json'])
  return result.code === 0
}

async function statusOf(id: McpClientId, resolved: Resolved): Promise<McpClientStatus> {
  const client = CLIENTS[id]
  const cli = findExecutableOnPath([client.cli], resolved.env, resolved.platform)
  const configPath = id === 'codex' ? codexConfigPath(resolved) : claudeConfigPath(resolved)
  const installed = cli ? (id === 'codex' ? await codexHasServer(resolved, cli) : claudeHasServer(resolved)) : false
  return {
    id,
    label: client.label,
    configPath,
    detected: Boolean(cli),
    installed,
    installMode: cli ? 'auto' : 'copy-only',
    // The state shows as a pill; only the way out of a missing CLI needs words.
    detail: cli ? '' : `没有找到 ${client.cli} 命令，可以复制 MCP 配置手动添加`,
  }
}

export async function getMcpClientsStatus(options: McpClientInstallerOptions = {}): Promise<McpClientStatus[]> {
  const resolved = resolve(options)
  return Promise.all((['codex', 'claude-code'] as const).map((id) => statusOf(id, resolved)))
}

function failure(client: string, result: RunResult): Error {
  const reason = (result.stderr || result.stdout).trim().split('\n').at(-1)?.slice(0, 200)
  return new Error(`${client} 没有完成，请在终端里查看 ${client} 是否可用${reason ? `（${reason}）` : ''}`)
}

async function register(id: McpClientId, resolved: Resolved, launch: BridgeLaunch): Promise<void> {
  const cli = findExecutableOnPath([CLIENTS[id].cli], resolved.env, resolved.platform)
  if (!cli) throw new Error(`没有找到 ${CLIENTS[id].cli} 命令，请先安装 ${CLIENTS[id].label}`)
  if (id === 'claude-code') {
    // Removed first so a changed path replaces the old entry; a missing entry is not an error here.
    await resolved.runCli(cli, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME])
    // No `timeout`: Claude Code's default for a stdio server (about 28 hours) already outlasts an approval.
    const config = { type: 'stdio', command: launch.command, args: launch.args, env: launch.env }
    const result = await resolved.runCli(cli, ['mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(config)])
    if (result.code !== 0) throw failure('claude mcp add-json', result)
    return
  }
  await resolved.runCli(cli, ['mcp', 'remove', MCP_SERVER_NAME])
  const env = Object.entries(launch.env).flatMap(([key, value]) => ['--env', `${key}=${value}`])
  const result = await resolved.runCli(cli, ['mcp', 'add', MCP_SERVER_NAME, ...env, '--', launch.command, ...launch.args])
  if (result.code !== 0) throw failure('codex mcp add', result)
  setCodexToolTimeout(codexConfigPath(resolved), CLIENT_TOOL_TIMEOUT_SEC)
}

export async function installMcpClient(id: McpClientId, options: McpClientInstallerOptions = {}): Promise<McpClientStatus> {
  const resolved = resolve(options)
  const launch = launchOf(resolved)
  await register(id, resolved, launch)
  writeRecords(resolved.recordPath, { ...readRecords(resolved.recordPath), [id]: launch })
  return statusOf(id, resolved)
}

export async function uninstallMcpClient(id: McpClientId, options: McpClientInstallerOptions = {}): Promise<McpClientStatus> {
  const resolved = resolve(options)
  const cli = findExecutableOnPath([CLIENTS[id].cli], resolved.env, resolved.platform)
  if (cli) {
    const args = id === 'claude-code' ? ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME] : ['mcp', 'remove', MCP_SERVER_NAME]
    const result = await resolved.runCli(cli, args)
    // Removing what is not there is fine; anything else is reported.
    if (result.code !== 0 && (id === 'codex' ? await codexHasServer(resolved, cli) : claudeHasServer(resolved))) {
      throw failure(`${CLIENTS[id].cli} mcp remove`, result)
    }
  }
  const records = readRecords(resolved.recordPath)
  delete records[id]
  writeRecords(resolved.recordPath, records)
  return statusOf(id, resolved)
}

/**
 * Registers again every client MossStudio registered whose launch changed: a
 * new app version runs from another folder, or node appeared or went away.
 */
export async function refreshMcpClientRegistrations(options: McpClientInstallerOptions = {}): Promise<void> {
  const resolved = resolve(options)
  const records = readRecords(resolved.recordPath)
  const launch = launchOf(resolved)
  for (const id of Object.keys(records) as McpClientId[]) {
    if (!(id in CLIENTS) || JSON.stringify(records[id]) === JSON.stringify(launch)) continue
    try {
      await register(id, resolved, launch)
      records[id] = launch
    } catch (error) {
      console.warn('[mcp] could not register again', id, error instanceof Error ? error.message : String(error))
    }
  }
  writeRecords(resolved.recordPath, records)
}

/** Removes only the registrations MossStudio recorded under `dataRoot` (used while uninstalling). */
export async function uninstallRecordedMcpClients(dataRoot: string, options: McpClientInstallerOptions = {}): Promise<void> {
  const recordPath = join(dataRoot, 'mcp', 'clients.json')
  for (const id of Object.keys(readRecords(recordPath)) as McpClientId[]) {
    // A client that hangs must not hold up the uninstall for long.
    if (id in CLIENTS) await uninstallMcpClient(id, { cliTimeoutMs: 8000, ...options, recordPath, stdioBridgePath: '', discoveryPath: '' })
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
