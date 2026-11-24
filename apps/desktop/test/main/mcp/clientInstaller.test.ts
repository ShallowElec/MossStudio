import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPROVAL_WAIT_MS } from '@shared/agentHub'
import { CLIENT_TOOL_TIMEOUT_SEC } from '@shared/mcpClients'
import {
  getMcpClientsStatus,
  installMcpClient,
  refreshMcpClientRegistrations,
  setCodexToolTimeout,
  uninstallMcpClient,
  uninstallRecordedMcpClients,
  type McpClientInstallerOptions,
} from '@main/mcp/clientInstaller'
import { findCli } from '@main/lib/cliDiscovery'
import type { RunResult } from '@main/lib/run'
import { useTempDir } from '@test/helpers/tempDir'

const dir = useTempDir()
const posix = process.platform !== 'win32'

/** A home folder with fake CLIs on PATH; `runCli` records calls and plays the CLI's part. */
function setup(clis: string[] = ['codex', 'claude', 'node'], registeredCodex?: Record<string, unknown>) {
  const home = join(dir(), 'home')
  const bin = join(dir(), 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })
  for (const name of clis) writeFileSync(join(bin, name), '', { mode: 0o755 })
  const calls: Array<{ command: string; args: string[] }> = []
  const codexToml = join(home, '.codex', 'config.toml')
  let codexEntry = registeredCodex
  let claudeServers: Record<string, unknown> = {}
  const runCli = async (command: string, args: string[]): Promise<RunResult> => {
    calls.push({ command, args })
    const ok = { code: 0, stdout: '', stderr: '', timedOut: false }
    if (command.endsWith('codex') && args[1] === 'add') {
      const dash = args.indexOf('--')
      codexEntry = {
        name: 'mossstudio',
        enabled: true,
        enabled_tools: null,
        disabled_tools: null,
        transport: {
          type: 'stdio',
          command: args[dash + 1],
          args: args.slice(dash + 2),
          env: Object.fromEntries(args.flatMap((a, i) => (a === '--env' ? [args[i + 1]!.split(/=(.*)/s).slice(0, 2)] : []))),
        },
      }
      mkdirSync(join(home, '.codex'), { recursive: true })
      const previous = existsSync(codexToml) ? readFileSync(codexToml, 'utf8') : ''
      writeFileSync(
        codexToml,
        `${previous}[mcp_servers.mossstudio]\ncommand = ${JSON.stringify(args[dash + 1])}\nargs = ${JSON.stringify(args.slice(dash + 2))}\n`,
      )
      return ok
    }
    if (command.endsWith('codex') && args[1] === 'get') {
      return codexEntry
        ? { ...ok, stdout: JSON.stringify(codexEntry) }
        : { ...ok, code: 1, stderr: "Error: No MCP server named 'mossstudio' found." }
    }
    if (command.endsWith('codex') && args[1] === 'remove') {
      codexEntry = undefined
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
    // Keeps a CI runner's own /usr/local/bin/node out of these tests.
    systemDirs: [],
    stdioBridgePath: join(dir(), 'data', 'mcp', 'mossstudio-mcp-stdio.mjs'),
    discoveryPath: join(dir(), 'data', 'mcp-server.json'),
    execPath: '/opt/MossStudio/app-2.0.1/MossStudio',
    recordPath: join(dir(), 'data', 'mcp', 'clients.json'),
    runCli,
  }
  return { home, bin, calls, codexToml, options, codexEntry: () => codexEntry, claudeServers: () => claudeServers }
}

function legacyCodex(policy: Record<string, unknown>) {
  const data = join(dir(), 'data')
  const launch = {
    command: 'node',
    args: [join(data, 'mcp', 'mossstudio-mcp-stdio.mjs')],
    env: { MOSSSTUDIO_MCP_DISCOVERY: join(data, 'mcp-server.json') },
  }
  const e = setup(['codex', 'node'], { name: 'mossstudio', transport: { type: 'stdio', ...launch }, enabled: true, ...policy })
  mkdirSync(dirname(e.options.recordPath!), { recursive: true })
  writeFileSync(e.options.recordPath!, JSON.stringify({ codex: launch }))
  return e
}

describe('main/mcp/clientInstaller', () => {
  it('refuses to overwrite or remove another user-scope server, even when a previous launch was recorded', async () => {
    const env = setup()
    await installMcpClient('claude-code', env.options)
    const record = readFileSync(env.options.recordPath!, 'utf8')
    const file = join(env.home, '.claude.json')
    const foreign = JSON.stringify({ mcpServers: { mossstudio: { type: 'http', url: 'https://example.test' } } })
    writeFileSync(file, foreign)
    env.calls.length = 0
    expect((await getMcpClientsStatus(env.options)).find((s) => s.id === 'claude-code')?.state).toBe('conflict')
    await expect(installMcpClient('claude-code', env.options)).rejects.toThrow()
    await expect(uninstallMcpClient('claude-code', env.options)).rejects.toThrow()
    expect(env.calls.filter((c) => c.args[1] !== 'get')).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(foreign)
    expect(readFileSync(env.options.recordPath!, 'utf8')).toBe(record)
  })

  it('a malformed record is never ownership proof for a malformed entry', async () => {
    const e = setup(['claude'])
    mkdirSync(join(dir(), 'data', 'mcp'), { recursive: true })
    writeFileSync(e.options.recordPath!, JSON.stringify({ 'claude-code': {} }))
    writeFileSync(join(e.home, '.claude.json'), JSON.stringify({ mcpServers: { mossstudio: {} } }))
    await expect(uninstallMcpClient('claude-code', e.options)).rejects.toThrow()
    expect(e.calls).toEqual([])
  })

  it('rejects a shell program with a lookalike npm last line', async () => {
    const e = setup([])
    writeFileSync(join(e.bin, 'claude.cmd'), '@echo off\r\necho custom\r\n"%_prog%" "%dp0%\\entry.js" %*')
    writeFileSync(join(e.bin, 'entry.js'), '')
    expect(await getMcpClientsStatus({ ...e.options, platform: 'win32' })).toContainEqual(
      expect.objectContaining({ id: 'claude-code', state: 'unsupported' }),
    )
  })

  it('retains the pending cleanup record when the CLI is missing', async () => {
    const env = setup(['claude'])
    await installMcpClient('claude-code', env.options)
    const record = readFileSync(env.options.recordPath!, 'utf8')
    env.options.env = { PATH: '' }
    await expect(uninstallMcpClient('claude-code', env.options)).rejects.toThrow(/清理/)
    expect(readFileSync(env.options.recordPath!, 'utf8')).toBe(record)
  })

  it('detects a CLI in a standard bin directory and never needs a shell', async () => {
    const env = setup([])
    const bin = join(env.home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'claude'), '', { mode: 0o755 })
    expect(await getMcpClientsStatus(env.options)).toContainEqual(
      expect.objectContaining({ id: 'claude-code', state: 'not_configured', installMode: 'auto' }),
    )
  })

  it.each(['npm', 'scoop/shims', 'AppData/Local/Volta/bin'])('uses Windows %s when PATH lacks a usable client', async (subdir) => {
    const e = setup([])
    const location = join(e.home, subdir)
    mkdirSync(location, { recursive: true })
    writeFileSync(join(location, 'claude.exe'), '')
    writeFileSync(join(e.bin, 'claude.bat'), '@echo off')
    const options = {
      ...e.options,
      platform: 'win32' as const,
      env: { PATH: e.bin, APPDATA: e.home, LOCALAPPDATA: join(e.home, 'AppData', 'Local'), PATHEXT: '.BAT;.EXE' },
    }
    expect(await getMcpClientsStatus(options)).toContainEqual(
      expect.objectContaining({ id: 'claude-code', state: 'not_configured', installMode: 'auto' }),
    )
    await expect(installMcpClient('claude-code', options)).rejects.toThrow('未能确认') // Test CLI does not persist .exe invocations.
    expect(e.calls[0]?.command).toBe(join(location, 'claude.exe'))
    writeFileSync(join(e.bin, 'claude.exe'), '')
    e.calls.length = 0
    await expect(installMcpClient('claude-code', options)).rejects.toThrow('未能确认')
    expect(e.calls[0]?.command).toBe(join(e.bin, 'claude.exe'))
  })

  it.each(['bat', 'cmd'])('does not run an unsupported .%s launcher', async (ext) => {
    const e = setup([])
    writeFileSync(join(e.bin, `claude.${ext}`), '@echo off\r\necho "%dp0%\\script.js"')
    writeFileSync(join(e.bin, 'script.js'), '')
    const options = { ...e.options, platform: 'win32' as const }
    expect(await getMcpClientsStatus(options)).toContainEqual(
      expect.objectContaining({ id: 'claude-code', state: 'unsupported', installMode: 'copy-only' }),
    )
    await expect(installMcpClient('claude-code', options)).rejects.toThrow()
    expect(e.calls).toEqual([])
  })

  it.runIf(posix)('refuses a regular POSIX file without X_OK', async () => {
    const e = setup(['claude'])
    chmodSync(join(e.bin, 'claude'), 0o600)
    expect(await getMcpClientsStatus(e.options)).toContainEqual(expect.objectContaining({ id: 'claude-code', state: 'unsupported' }))
    await expect(installMcpClient('claude-code', e.options)).rejects.toThrow()
    expect(e.calls).toEqual([])
  })

  it('detects only the selected DSH directory and never edits its contents', async () => {
    const e = setup([])
    const home = join(e.home, '.dsh')
    mkdirSync(home)
    const cfg = join(home, 'cordis.patch.yml')
    writeFileSync(cfg, 'untouched')
    const probe = async () => (await getMcpClientsStatus(e.options)).find((c) => c.id === 'dsh')
    expect(await probe()).toMatchObject({ state: 'detected', installMode: 'copy-only', configPath: home })
    e.options.env!.DSH_HOME = dir()
    expect(await probe()).toMatchObject({ state: 'detected', configPath: dir() })
    e.options.env!.DSH_HOME = cfg
    expect(await probe()).toMatchObject({ state: 'not_found' })
    expect(readFileSync(cfg, 'utf8')).toBe('untouched')
    expect(e.calls).toEqual([])
  })

  it.each([
    ['foreign transport', 0, JSON.stringify({ name: 'mossstudio', transport: { type: 'http', url: 'https://example.test' } }), 'conflict'],
    [
      'disabled foreign server',
      0,
      JSON.stringify({ name: 'mossstudio', enabled: false, transport: { type: 'stdio', command: 'other' } }),
      'conflict',
    ],
    ['CLI failure', 1, '', 'unknown'],
    ['bad JSON', 0, '{', 'unknown'],
  ] as const)('Codex %s never permits a mutation', async (_, code, stdout, state) => {
    const e = setup(['codex'])
    const calls: string[][] = []
    e.options.runCli = async (_cmd, args) => {
      calls.push(args)
      return { code, stdout, stderr: '', timedOut: false }
    }
    expect((await getMcpClientsStatus(e.options))[0]?.state).toBe(state)
    await expect(installMcpClient('codex', e.options)).rejects.toThrow()
    await expect(installMcpClient('codex', { ...e.options, resetPolicy: true })).rejects.toThrow()
    await expect(uninstallMcpClient('codex', e.options)).rejects.toThrow()
    expect(calls.every((a) => a[1] === 'get')).toBe(true)
    expect(existsSync(e.options.recordPath!)).toBe(false)
  })

  for (const [id, name] of [
    ['codex', 'codex'],
    ['claude-code', 'claude'],
  ] as const)
    it.runIf(findCli(name).kind === 'ready')(
      `round-trips a real ${id} registration in isolated homes`,
      async () => {
        const e = setup([])
        const config = join(e.home, 'isolated')
        mkdirSync(config)
        const options = {
          ...e.options,
          platform: process.platform,
          runCli: undefined,
          env: { ...process.env, HOME: e.home, USERPROFILE: e.home, CODEX_HOME: config, CLAUDE_CONFIG_DIR: config },
        }
        expect(await installMcpClient(id, options)).toMatchObject({ state: 'configured' })
        if (id === 'codex') expect(readFileSync(join(config, 'config.toml'), 'utf8')).toContain('tool_timeout_sec = 180')
        expect(await uninstallMcpClient(id, options)).toMatchObject({ state: 'not_configured' })
      },
      45000,
    )

  it.runIf(findCli('codex').kind === 'ready')(
    'leaves the actual disabled Codex TOML byte-for-byte intact on upgrade',
    async () => {
      const e = legacyCodex({ enabled: false, disabled_tools: ['some_tool'] })
      const config = dirname(e.codexToml)
      mkdirSync(config, { recursive: true })
      const toml = `[mcp_servers.mossstudio]\ncommand = "node"\nargs = ${JSON.stringify([e.options.stdioBridgePath])}\nenabled = false\ndisabled_tools = ["some_tool"]\n[mcp_servers.mossstudio.env]\nMOSSSTUDIO_MCP_DISCOVERY = ${JSON.stringify(e.options.discoveryPath)}\n`
      writeFileSync(e.codexToml, toml)
      const options = {
        ...e.options,
        runCli: undefined,
        platform: process.platform,
        env: { ...process.env, HOME: e.home, USERPROFILE: e.home, CODEX_HOME: config, CLAUDE_CONFIG_DIR: e.home },
      }
      await refreshMcpClientRegistrations(options)
      expect(readFileSync(e.codexToml, 'utf8')).toBe(toml)
      expect((await getMcpClientsStatus(options))[0]).toMatchObject({ state: 'custom_policy', detail: expect.stringContaining('已禁用') })
    },
    45000,
  )

  it('waits longer for a tool call than an approval waits', () => {
    expect(CLIENT_TOOL_TIMEOUT_SEC * 1000).toBeGreaterThan(APPROVAL_WAIT_MS)
  })

  it("registers with Claude Code through its CLI, with the person's node and no shell (its own tool timeout is about 28 hours)", async () => {
    const env = setup()
    const status = await installMcpClient('claude-code', env.options)
    expect(status).toMatchObject({ id: 'claude-code', state: 'configured', installMode: 'auto' })
    expect(env.calls.map((call) => call.args.slice(0, 2))).toEqual([['mcp', 'add-json']])
    expect(env.calls[0]!.args.slice(2, 5)).toEqual(['--scope', 'user', 'mossstudio'])
    expect(env.claudeServers().mossstudio).toEqual({
      type: 'stdio',
      command: join(env.bin, 'node'),
      args: [env.options.stdioBridgePath],
      env: { MOSSSTUDIO_MCP_DISCOVERY: env.options.discoveryPath },
    })
    const removed = await uninstallMcpClient('claude-code', env.options)
    expect(removed.state).toBe('not_configured')
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
    expect(status).toMatchObject({ id: 'codex', state: 'configured' })
    const add = env.calls.find((call) => call.args[1] === 'add')!
    expect(add.args).toEqual([
      'mcp',
      'add',
      'mossstudio',
      '--env',
      `MOSSSTUDIO_MCP_DISCOVERY=${env.options.discoveryPath}`,
      '--',
      join(env.bin, 'node'),
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
    expect(statuses.map((status) => [status.id, status.installMode, status.state])).toEqual([
      ['codex', 'copy-only', 'not_found'],
      ['claude-code', 'copy-only', 'not_found'],
      ['dsh', 'copy-only', 'not_found'],
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
    const moved = { ...env.options, execPath: '/opt/MossStudio/app-2.1.0/MossStudio' }
    expect(await getMcpClientsStatus(moved)).toContainEqual(expect.objectContaining({ id: 'claude-code', state: 'needs_refresh' }))
    await refreshMcpClientRegistrations(moved)
    expect(env.claudeServers().mossstudio).toMatchObject({ command: '/opt/MossStudio/app-2.1.0/MossStudio' })
  })

  it.each([
    { enabled: false, disabled_tools: ['some_tool'] },
    { enabled: false },
    { disabled_tools: ['some_tool'] },
    { enabled_tools: ['read_only'] },
    { enabled_tools: [], disabled_tools: null },
  ])('preserves the entire legacy Codex entry on background refresh with policy %j', async (policy) => {
    const e = legacyCodex(policy)
    const original = structuredClone(e.codexEntry())
    const record = readFileSync(e.options.recordPath!, 'utf8')
    await refreshMcpClientRegistrations(e.options)
    expect(e.calls.map((call) => call.args)).toEqual([['mcp', 'get', 'mossstudio', '--json']])
    expect(e.codexEntry()).toEqual(original)
    expect(readFileSync(e.options.recordPath!, 'utf8')).toBe(record)
    expect((await getMcpClientsStatus(e.options))[0]).toMatchObject({
      state: 'custom_policy',
      detail: expect.stringContaining('未自动覆盖'),
    })
  })

  it('requires consent to reset a protected Codex entry even if the last status check missed the policy', async () => {
    const e = legacyCodex({ enabled: false, disabled_tools: ['some_tool'] })
    await expect(installMcpClient('codex', e.options)).rejects.toThrow(/重新连接/)
    expect(e.calls.map((call) => call.args[1])).toEqual(['get'])
    const status = await installMcpClient('codex', { ...e.options, resetPolicy: true })
    expect(status.state).toBe('configured')
    expect(e.calls.map((call) => call.args[1]).filter((op) => op !== 'get')).toEqual(['remove', 'add'])
    expect(e.codexEntry()).toMatchObject({ enabled: true, disabled_tools: null, transport: { command: join(e.bin, 'node') } })
  })

  it.each([{}, { enabled_tools: null, disabled_tools: [] }])(
    'refreshes an unrestricted legacy Codex entry with policy %j',
    async (policy) => {
      const e = legacyCodex(policy)
      await refreshMcpClientRegistrations(e.options)
      expect(e.calls.map((call) => call.args[1]).filter((op) => op !== 'get')).toEqual(['remove', 'add'])
      expect(e.codexEntry()).toMatchObject({ transport: { command: join(e.bin, 'node') } })
    },
  )

  it('uninstalling the app removes only the clients MossStudio registered', async () => {
    const env = setup()
    await installMcpClient('claude-code', env.options)
    env.calls.length = 0
    const dataRoot = join(dir(), 'data')
    await uninstallRecordedMcpClients(dataRoot, { ...env.options, recordPath: undefined })
    expect(env.calls.map((call) => basename(call.command))).toEqual(['claude'])
    expect(env.claudeServers()).toEqual({})
  })

  it('uninstalling the app also removes a registration made while the bridge ran from the bundled copy', async () => {
    const env = setup()
    const { stdioBridgePath: _stable, ...options } = env.options
    const bundled = join(dir(), 'app-2.0.1', 'resources', 'tools', 'mcp', 'mossstudio-mcp-stdio.mjs')
    await installMcpClient('codex', { ...options, stdioBridgePath: bundled })
    await installMcpClient('claude-code', { ...options, stdioBridgePath: bundled })
    await uninstallRecordedMcpClients(join(dir(), 'data'), { ...options, recordPath: undefined })
    expect(env.codexEntry()).toBeUndefined()
    expect(env.claudeServers()).toEqual({})
    expect(JSON.parse(readFileSync(env.options.recordPath!, 'utf8'))).toEqual({})
  })
})
