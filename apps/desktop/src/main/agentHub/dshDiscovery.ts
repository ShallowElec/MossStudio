import { constants } from 'node:fs'
import { lstat, open, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { isNetworkPath, pathLinksToNetwork } from '../lib/localPath'
import { basename, join } from 'node:path'
import { paths } from '../lib/paths'
import { run } from '../lib/run'

export interface DesktopListener {
  origin: string
  pid: number
}

const DESKTOP_NAME = /^(?:DeepSeek Harness|deepseek-harness)(?: Helper(?: \(Plugin\))?)?$/i

/** Processes in `ps -o pid=,comm=` output named like the desktop app; `exact: false` is a Linux name cut to 15 characters. */
export function desktopPids(ps: string): Array<{ pid: number; exact: boolean }> {
  return ps.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    const name = row ? basename(row[2]!) : ''
    const exact = DESKTOP_NAME.test(name)
    return row && (exact || /^(?:DeepSeek Harnes|deepseek-harnes)$/i.test(name)) ? [{ pid: Number(row[1]), exact }] : []
  })
}

// The kernel prints each 32-bit word of an address in host byte order; Electron's Linux builds are all little-endian.
const PROC_LOOPBACK = new Map([
  ['0100007F', '127.0.0.1'],
  ['00000000000000000000000001000000', '::1'],
])

/** Loopback sockets in the LISTEN state (`0A`) from `/proc/net/tcp` or `/proc/net/tcp6` text, with each socket's inode. */
export function procListeners(text: string): Array<{ inode: number; host: string; port: number }> {
  return text.split('\n').flatMap((line) => {
    const [, local, , state, , , , , , inode] = line.trim().split(/\s+/)
    const addr = /^([\dA-F]+):([\dA-F]{4})$/i.exec(local ?? '')
    const host = PROC_LOOPBACK.get(addr?.[1]?.toUpperCase() ?? '')
    return addr && host && state === '0A' && /^\d+$/.test(inode ?? '') ? [{ inode: Number(inode), host, port: parseInt(addr[2]!, 16) }] : []
  })
}

/** The inode of a `/proc/<pid>/fd/<n>` link target such as `socket:[12345]`. */
export function socketInode(link: string): number | undefined {
  const m = /^socket:\[(\d+)\]$/.exec(link)
  return m ? Number(m[1]) : undefined
}

/** Linux: the loopback listeners `pids` own, read from /proc without starting a process; undefined when /proc cannot be read. */
async function procSockets(pids: number[], signal: AbortSignal, timeoutMs: number) {
  const stop = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const tables = await Promise.all(
    ['/proc/net/tcp', '/proc/net/tcp6'].map((path) => readFile(path, { encoding: 'utf8', signal: stop }).catch(() => undefined)),
  )
  signal.throwIfAborted()
  if (tables.every((table) => table === undefined)) return undefined
  const owners = new Map<number, number>()
  for (const pid of pids) {
    for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [])) {
      if (stop.aborted) break
      const inode = socketInode(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''))
      if (inode !== undefined) owners.set(inode, pid)
    }
  }
  return tables.flatMap((table) =>
    procListeners(table ?? '').flatMap(({ inode, host, port }) => {
      const pid = owners.get(inode)
      return pid ? [{ pid, host, port }] : []
    }),
  )
}

/** Only inspect listening sockets owned by the desktop binary. No port scan, credentials, process arguments or contact with other servers. */
export async function desktopListeners(signal: AbortSignal): Promise<DesktopListener[]> {
  const opts = { timeoutMs: 6000, signal }
  const rows: DesktopListener[] = []
  const add = (pid: number, host: string, port: number) => {
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(port) && port > 0 && port < 65536 && ['127.0.0.1', '::1'].includes(host))
      rows.push({ pid, origin: `http://${host === '::1' ? '[::1]' : host}:${port}` })
  }
  if (process.platform === 'win32') {
    const script =
      "$p=@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainModule.FileVersionInfo.ProductName -eq 'DeepSeek Harness' } | ForEach-Object Id); if ($p.Count) { Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $p -and $_.LocalAddress -in '127.0.0.1','::1' } | ForEach-Object { '{0} {1} {2}' -f $_.OwningProcess,$_.LocalAddress,$_.LocalPort } }"
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], opts)
    for (const line of stdout.trim().split(/\r?\n/)) {
      const [pid, host, port] = line.trim().split(/\s+/)
      add(Number(pid), host ?? '', Number(port))
    }
  } else {
    const { stdout } = await run('ps', ['-A', '-o', 'pid=,comm='], opts)
    const pids: number[] = []
    for (const { pid, exact } of desktopPids(stdout)) {
      // Linux cuts comm to 15 characters; the executable's own name settles it. A binary replaced by an upgrade reads as `… (deleted)`.
      const exe = async () => (await readlink(`/proc/${pid}/exe`).catch(() => '')).replace(/ \(deleted\)$/, '')
      if (exact || (process.platform === 'linux' && DESKTOP_NAME.test(basename(await exe())))) pids.push(pid)
    }
    const found = pids.length && process.platform === 'linux' ? await procSockets(pids, signal, opts.timeoutMs) : undefined
    for (const row of found ?? []) add(row.pid, row.host, row.port)
    // macOS, and Linux without a readable /proc.
    if (pids.length && !found) {
      const sockets = await run('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'], opts)
      let pid = 0
      for (const line of sockets.stdout.split('\n')) {
        if (/^p\d+$/.test(line)) pid = Number(line.slice(1))
        const addr = /^n(127\.0\.0\.1|\[::1\]):(\d+)$/.exec(line)
        if (addr) add(pid, addr[1] === '[::1]' ? '::1' : addr[1]!, Number(addr[2]))
      }
    }
  }
  signal.throwIfAborted()
  return rows
}

export async function pairingFor(listeners: DesktopListener[]): Promise<string | undefined> {
  if (process.env.MOSSSTUDIO_DSH_PAIRING_URL) return process.env.MOSSSTUDIO_DSH_PAIRING_URL
  // Optional local integration handoff. A stale file never establishes listener ownership or chooses a remote origin.
  const path = join(paths.root(), 'dsh-desktop-live.json')
  if (isNetworkPath(path) || (await pathLinksToNetwork(path))) return undefined
  const before = await lstat(path).catch(() => null)
  if (
    !before?.isFile() ||
    before.nlink !== 1 ||
    before.size > 4096 ||
    (process.getuid && (before.uid !== process.getuid() || (before.mode & 0o077) !== 0)) ||
    (await realpath(path).catch(() => '')) !== path
  )
    return undefined
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)).catch(() => null)
  if (!file) return undefined
  try {
    const st = await file.stat()
    if (!st.isFile() || st.size > 4096 || st.ino !== before.ino || st.dev !== before.dev || st.ctimeMs !== before.ctimeMs) return undefined
    const bytes = Buffer.alloc(4096)
    const { bytesRead } = await file.read(bytes)
    const row = JSON.parse(bytes.toString('utf8', 0, bytesRead)) as { version?: number; pid?: number; pairingUrl?: string }
    if (
      row.version === 1 &&
      typeof row.pairingUrl === 'string' &&
      listeners.some((r) => r.pid === row.pid && r.origin === new URL(row.pairingUrl!).origin)
    )
      return row.pairingUrl
  } catch {
    /* Incomplete or obsolete handshake: ask the operator for a launch URL instead. */
  } finally {
    await file.close()
  }
  return undefined
}
