import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPROVAL_WAIT_MS } from '@main/agentHub/approvalQueue'
import {
  CLIENT_TOOL_TIMEOUT_SEC,
  getMcpClientsStatus,
  installMcpClient,
  refreshMcpClientRegistrations,
  setCodexToolTimeout,
  uninstallMcpClient,
  uninstallRecordedMcpClients,
  type McpClientInstallerOptions,
} from '@main/mcp/clientInstaller'
import type { RunResult } from '@main/lib/run'
import { useTempDir } from '@test/helpers/tempDir'

const dir = useTempDir()
const posix = process.platform !== 'win32'

/** A home folder with fake CLIs on PATH; `runCli` records calls and plays the CLI's part. */
function setup(clis: string[] = ['codex', 'claude', 'node']) {
  const home = join(dir(), 'home')
  const bin = join(dir(), 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })
  for (const name of clis) writeFileSync(join(bin, name), '', { mode: 0o755 })
  const calls: Array<{ command: string; args: string[] }> = []
  const codexToml = join(home, '.codex', 'config.toml')
  let claudeServers: Record<string, unknown> = {}
  const runCli = async (command: string, args: string[]): Promise<RunResult> => {
    calls.push({ command, args })
    const ok = { code: 0, stdout: '', stderr: '', timedOut: false }
    if (command.endsWith('codex') && args[1] === 'add') {
      const dash = args.indexOf('--')
      mkdirSync(join(home, '.codex'), { recursive: true })
      const previous = existsSync(codexToml) ? readFileSync(codexToml, 'utf8') : ''
      writeFileSync(
        codexToml,
        `${previous}[mcp_servers.mossstudio]\ncommand = ${JSON.stringify(args[dash + 1])}\nargs = ${JSON.stringify(args.slice(dash + 2))}\n`,
      )
      return ok
    }
    if (command.endsWith('codex') && args[1] === 'get') {
      return existsSync(codexToml) && readFileSync(codexToml, 'utf8').includes('[mcp_servers.mossstudio]') ? ok : { ...ok, code: 1 }
    }
    if (command.endsWith('codex') && args[1] === 'remove') {
      if (existsSync(codexToml)) writeFileSync(codexToml, readFileSync(codexToml, 'utf8').split('[mcp_servers.mossstudio]')[0]!)
      return ok
    }
    if (command.endsWith('claude')) {
      if (args[1] === 'add-json') claudeServers = { ...claudeServers, [args[4]!]: JSON.parse(args[5]!) }
      if (args[1] === 'remove') delete claudeServers[args.at(-1)!]
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: claudeServers }))
      return ok
    }
    return ok
  }
  const options: McpClientInstallerOptions = {
    homeDir: home,
    env: { PATH: bin },
    platform: 'linux',
    stdioBridgePath: join(dir(), 'data', 'mcp', 'mossstudio-mcp-stdio.mjs'),
    discoveryPath: join(dir(), 'data', 'mcp-server.json'),
    execPath: '/opt/MossStudio/app-2.0.1/MossStudio',
    recordPath: join(dir(), 'data', 'mcp', 'clients.json'),
    runCli,
  }
  return { home, bin, calls, codexToml, options, claudeServers: () => claudeServers }
}

describe('main/mcp/clientInstaller', () => {
  it('waits longer for a tool call than an approval waits', () => {
    expect(CLIENT_TOOL_TIMEOUT_SEC * 1000).toBeGreaterThan(APPROVAL_WAIT_MS)
  })

  it("registers with Claude Code through its CLI, with the person's node, a timeout, and no shell", async () => {
    const env = setup()
    const status = await installMcpClient('claude-code', env.options)
    expect(status).toMatchObject({ id: 'claude-code', detected: true, installed: true, installMode: 'auto' })
    expect(env.calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['mcp', 'remove'],
      ['mcp', 'add-json'],
    ])
    expect(env.calls[1]!.args.slice(2, 5)).toEqual(['--scope', 'user', 'mossstudio'])
    expect(env.claudeServers().mossstudio).toEqual({
      type: 'stdio',
      command: 'node',
      args: [env.options.stdioBridgePath],
      env: { MOSSSTUDIO_MCP_DISCOVERY: env.options.discoveryPath },
      timeout: CLIENT_TOOL_TIMEOUT_SEC * 1000,
    })
    const removed = await uninstallMcpClient('claude-code', env.options)
    expect(removed.installed).toBe(false)
    expect(env.calls.at(-1)!.args).toEqual(['mcp', 'remove', '--scope', 'user', 'mossstudio'])
    expect(JSON.parse(readFileSync(env.options.recordPath!, 'utf8'))).toEqual({})
  })

  it('runs the bridge with this app as node only when there is no node, and only then sets ELECTRON_RUN_AS_NODE', async () => {
    const env = setup(['claude'])
    await installMcpClient('claude-code', env.options)
    expect(env.claudeServers().mossstudio).toMatchObject({
      command: '/opt/MossStudio/app-2.0.1/MossStudio',
      env: { ELECTRON_RUN_AS_NODE: '1', MOSSSTUDIO_MCP_DISCOVERY: env.options.discoveryPath },
    })
  })

  it('registers with Codex through `codex mcp add` and adds only the tool timeout to the table Codex wrote', async () => {
    const env = setup()
    mkdirSync(join(env.home, '.codex'), { recursive: true })
    writeFileSync(env.codexToml, 'model = "gpt-5.4"\n\n[mcp_servers.other]\ncommand = "npx"\n', { mode: 0o600 })
    const status = await installMcpClient('codex', env.options)
    expect(status).toMatchObject({ id: 'codex', installed: true })
    const add = env.calls.find((call) => call.args[1] === 'add')!
    expect(add.args).toEqual([
      'mcp',
      'add',
      'mossstudio',
      '--env',
      `MOSSSTUDIO_MCP_DISCOVERY=${env.options.discoveryPath}`,
      '--',
      'node',
      env.options.stdioBridgePath,
    ])
    const toml = readFileSync(env.codexToml, 'utf8')
    expect(toml).toContain('[mcp_servers.other]\ncommand = "npx"')
    expect(toml).toContain(`[mcp_servers.mossstudio]\ntool_timeout_sec = ${CLIENT_TOOL_TIMEOUT_SEC}\n`)
    if (posix) expect(statSync(env.codexToml).mode & 0o777).toBe(0o600)
    await installMcpClient('codex', env.options)
    expect(readFileSync(env.codexToml, 'utf8').match(/tool_timeout_sec/g)).toHaveLength(1)
    expect(readdirSync(join(env.home, '.codex')).filter((name) => name.includes('backup'))).toEqual(['config.toml.mossstudio-backup'])
  })

  it.runIf(posix)('edits the real Codex config through a symlink, keeping the link and its permissions', () => {
    const env = setup()
    const real = join(dir(), 'dotfiles', 'codex.toml')
    mkdirSync(join(dir(), 'dotfiles'), { recursive: true })
    mkdirSync(join(env.home, '.codex'), { recursive: true })
    writeFileSync(real, '[mcp_servers.mossstudio]\ncommand = "node"\n', { mode: 0o600 })
    chmodSync(real, 0o600)
    symlinkSync(real, env.codexToml)
    expect(setCodexToolTimeout(env.codexToml, 180)).toBe(true)
    expect(lstatSync(env.codexToml).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('[mcp_servers.mossstudio]\ntool_timeout_sec = 180\ncommand = "node"\n')
    expect(statSync(real).mode & 0o777).toBe(0o600)
  })

  it('leaves a Codex config alone when mossstudio is defined inline, dotted, or twice', () => {
    const env = setup()
    mkdirSync(join(env.home, '.codex'), { recursive: true })
    for (const text of [
      '[mcp_servers]\nmossstudio = { command = "node" }\n',
      'mcp_servers.mossstudio.command = "node"\n',
      'mcp_servers = { mossstudio = { command = "node" } }\n',
      '[mcp_servers.mossstudio]\ncommand = "a"\n[mcp_servers."mossstudio"]\ncommand = "b"\n',
    ]) {
      writeFileSync(env.codexToml, text)
      expect(setCodexToolTimeout(env.codexToml, 180), text).toBe(false)
      expect(readFileSync(env.codexToml, 'utf8')).toBe(text)
    }
  })

  it('offers copying instead when a client has no CLI here, and writes nothing', async () => {
    const env = setup(['node'])
    const statuses = await getMcpClientsStatus(env.options)
    expect(statuses.map((status) => [status.id, status.installMode, status.installed])).toEqual([
      ['codex', 'copy-only', false],
      ['claude-code', 'copy-only', false],
    ])
    await expect(installMcpClient('codex', env.options)).rejects.toThrow('没有找到 codex')
    expect(env.calls).toEqual([])
    expect(existsSync(env.options.recordPath!)).toBe(false)
  })

  it('registers again after an update moved the app to another folder, and leaves an unchanged one alone', async () => {
    const env = setup(['claude'])
    await installMcpClient('claude-code', env.options)
    env.calls.length = 0
    await refreshMcpClientRegistrations(env.options)
    expect(env.calls).toEqual([])
    await refreshMcpClientRegistrations({ ...env.options, execPath: '/opt/MossStudio/app-2.1.0/MossStudio' })
    expect(env.claudeServers().mossstudio).toMatchObject({ command: '/opt/MossStudio/app-2.1.0/MossStudio' })
  })

  it('uninstalling the app removes only the clients MossStudio registered', async () => {
    const env = setup()
    await installMcpClient('claude-code', env.options)
    env.calls.length = 0
    const dataRoot = join(dir(), 'data')
    await uninstallRecordedMcpClients(dataRoot, { ...env.options, recordPath: undefined })
    expect(env.calls.map((call) => call.command.split('/').at(-1))).toEqual(['claude'])
    expect(env.claudeServers()).toEqual({})
  })
})
