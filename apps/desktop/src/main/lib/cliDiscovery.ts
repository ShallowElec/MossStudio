import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { isNetworkPath } from './localPath'

interface Search {
  home?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Package-manager folders outside the home folder (Homebrew); tests replace them so the machine's own installs stay out. */
  systemDirs?: readonly string[]
}

const SYSTEM_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

type Candidate = { kind: 'ready'; path: string; script?: string } | { kind: 'unsupported' | 'missing' }

/** Inspect npm's Node launcher, never evaluate batch syntax or expand its variables. */
function shimEntry(file: string): string | undefined {
  if (statSync(file).size > 8192) return
  const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const last = lines.pop() ?? ''
  const prologue = lines
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
    .join('\n')
  const npmPrologue = String.raw`@echo off
goto start
:find_dp0
set dp0=%~dp0
exit /b
:start
setlocal
call :find_dp0
if exist "%dp0%\node.exe" (
set "_prog=%dp0%\node.exe"
) else (
set "_prog=node"
set pathext=%pathext:;.js;=;%
)`
  if (prologue !== npmPrologue) return
  const entry =
    /^(?:endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & )?"%_prog%"\s+"%dp0%[\\/]([^"%:\r\n]+\.(?:js|cjs|mjs))" %\*$/i.exec(
      last,
    )?.[1]
  if (!entry || entry.split(/[\\/]/).some((part) => !part || part === '..' || part === '.')) return
  const script = resolve(dirname(file), entry.replace(/\\/g, '/'))
  return statSync(script, { throwIfNoEntry: false })?.isFile() ? script : undefined
}

export function findCli(
  name: string,
  { home = homedir(), env = process.env, platform = process.platform, systemDirs = SYSTEM_DIRS }: Search = {},
): Candidate {
  const windows = platform === 'win32'
  const dirs = (env.PATH ?? env.Path ?? '').split(windows ? ';' : delimiter).map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
  dirs.push(
    ...(windows
      ? [env.APPDATA && join(env.APPDATA, 'npm'), join(home, 'scoop', 'shims'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Volta', 'bin')]
      : [join(home, '.local', 'bin'), ...systemDirs, join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin')]
    ).filter((d): d is string => !!d),
  )
  if (windows) dirs.push(join(env.USERPROFILE || home, '.local', 'bin'))
  const extensions =
    windows && !extname(name)
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .toLowerCase()
          .split(';')
          .filter((e) => /^\.[a-z0-9]+$/.test(e))
      : ['']
  const bases = isAbsolute(name) ? [name] : /[\\/]/.test(name) ? [] : [...new Set(dirs.filter(isAbsolute))].map((dir) => join(dir, name))
  let found = false
  for (const base of bases)
    for (const ext of extensions) {
      const file = base + ext
      if (isNetworkPath(file)) continue
      try {
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue
        found = true
        if (!windows) accessSync(file, constants.X_OK)
        else if (/\.cmd$/i.test(file) && name !== 'node') {
          const script = shimEntry(file)
          if (script) return { kind: 'ready', path: file, script }
          continue
        } else if (!/\.exe$/i.test(file)) continue
        return { kind: 'ready', path: file }
      } catch {
        /* A stale or inaccessible candidate does not hide a later usable one. */
      }
    }
  return { kind: found ? 'unsupported' : 'missing' }
}

export function cliLaunch(command: string, args: string[], search: Search = {}, execPath = process.execPath) {
  const cli = findCli(command, search)
  if (cli.kind !== 'ready')
    throw new Error(cli.kind === 'missing' ? `没有找到 ${command} 命令` : '命令不可执行或不是受支持的 Node.js 启动脚本')
  if (!cli.script) return { command: cli.path, args }
  const local = join(dirname(cli.path), 'node.exe')
  const node = statSync(local, { throwIfNoEntry: false })?.isFile() ? local : findCli('node', search)
  return { command: typeof node === 'string' ? node : node.kind === 'ready' ? node.path : execPath, args: [cli.script, ...args] }
}

export function childEnv(command: string, source = process.env, execPath = process.execPath): NodeJS.ProcessEnv {
  return { ...source, ELECTRON_RUN_AS_NODE: command === execPath ? '1' : undefined }
}
