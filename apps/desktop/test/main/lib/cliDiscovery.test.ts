import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { findCli } from '@main/lib/cliDiscovery'
import { useTempDir } from '@test/helpers/tempDir'

/** Executables that exist only for these tests, in folders a test cannot write to (`/usr/local/bin`, a network share). */
const virtual = vi.hoisted(() => new Set<string>())
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const statSync = ((file: string, options?: object) =>
    virtual.has(String(file)) ? { isFile: () => true, size: 0 } : actual.statSync(file, options)) as typeof actual.statSync
  const accessSync = (file: string, mode?: number) => (virtual.has(String(file)) ? undefined : actual.accessSync(file, mode))
  return { ...actual, statSync, accessSync, default: { ...actual, statSync, accessSync } }
})

const temp = useTempDir()

/** npm's Windows launcher for a package bin, as `npm install -g` writes it. */
const npmShim = (entry: string) =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*`,
  ].join('\r\n')

it('finds native Claude Code under the Windows user profile without PATH', () => {
  const profile = join(temp(), 'user profile')
  const bin = join(profile, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const cli = join(bin, 'claude.exe')
  writeFileSync(cli, '')
  const localAppData = join(temp(), 'AppData', 'Local')
  const search = { platform: 'win32' as const, home: temp(), env: { USERPROFILE: profile, LOCALAPPDATA: localAppData } }
  expect(findCli('claude', search)).toEqual({ kind: 'ready', path: cli })

  // Adding the native fallback must not switch an existing Volta installation.
  const volta = join(localAppData, 'Volta', 'bin')
  mkdirSync(volta, { recursive: true })
  writeFileSync(join(volta, 'claude.exe'), '')
  expect(findCli('claude', search)).toEqual({ kind: 'ready', path: join(volta, 'claude.exe') })
})

it('looks in Volta’s Windows folder, not the ~/.volta it uses elsewhere', () => {
  const unixVolta = join(temp(), '.volta', 'bin')
  mkdirSync(unixVolta, { recursive: true })
  writeFileSync(join(unixVolta, 'codex.exe'), '')
  expect(findCli('codex', { platform: 'win32', home: temp(), env: { LOCALAPPDATA: join(temp(), 'AppData', 'Local') } })).toEqual({
    kind: 'missing',
  })
})

it('finds an Intel Homebrew install in /usr/local/bin, after everything on PATH', () => {
  const name = 'mossstudio-test-intel-brew-cli'
  virtual.add(`/usr/local/bin/${name}`)
  try {
    const search = { platform: 'darwin' as const, home: temp(), env: { PATH: '' } }
    expect(findCli(name, search)).toEqual({ kind: 'ready', path: `/usr/local/bin/${name}` })
    const bin = join(temp(), 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, name), '', { mode: 0o755 })
    expect(findCli(name, { ...search, env: { PATH: bin } })).toEqual({ kind: 'ready', path: join(bin, name) })
  } finally {
    virtual.delete(`/usr/local/bin/${name}`)
  }
})

it('runs an npm shim only through its own script, and never one that climbs out of its folder', () => {
  const bin = join(temp(), 'npm')
  mkdirSync(join(bin, 'node_modules', 'codex'), { recursive: true })
  const script = join(bin, 'node_modules', 'codex', 'cli.js')
  writeFileSync(script, '')
  writeFileSync(join(temp(), 'outside.js'), '')
  const search = { platform: 'win32' as const, home: temp(), env: { PATH: bin } }

  writeFileSync(join(bin, 'codex.cmd'), npmShim('node_modules\\codex\\cli.js'))
  expect(findCli('codex', search)).toEqual({ kind: 'ready', path: join(bin, 'codex.cmd'), script })

  writeFileSync(join(bin, 'codex.cmd'), npmShim('..\\outside.js'))
  expect(findCli('codex', search)).toEqual({ kind: 'unsupported' })
  writeFileSync(join(bin, 'codex.cmd'), npmShim('node_modules\\codex\\..\\..\\..\\outside.js'))
  expect(findCli('codex', search)).toEqual({ kind: 'unsupported' })
})

it('never opens a program on a network share, where opening alone sends the person’s Windows credentials', () => {
  const share = '//fileserver/tools/claude.exe'
  virtual.add(share)
  try {
    expect(findCli(share, { platform: 'win32', home: temp(), env: {} })).toEqual({ kind: 'missing' })
  } finally {
    virtual.delete(share)
  }
})
