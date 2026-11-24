import { afterEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ lstat: vi.fn(), readlink: vi.fn(), readFile: vi.fn(), readdir: vi.fn() }))
const useRealFs = vi.hoisted(() => ({ run: () => {} }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  useRealFs.run = () => {
    for (const name of ['lstat', 'readlink', 'readFile', 'readdir'] as const) fs[name].mockReset().mockImplementation(actual[name])
  }
  useRealFs.run()
  return { ...actual, ...fs, default: { ...actual, ...fs } }
})
const run = vi.hoisted(() => vi.fn())
vi.mock('@main/lib/run', async (importOriginal) => ({ ...(await importOriginal<typeof import('@main/lib/run')>()), run }))

import { chmodSync, linkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopListeners, desktopPids, pairingFor, procListeners, socketInode } from '@main/agentHub/dshDiscovery'
import { useTempDataRoot } from '@test/helpers/tempDir'

const platform = process.platform
const onPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value })
afterEach(() => {
  onPlatform(platform)
  run.mockReset()
  useRealFs.run()
})
const output = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false })

// Rows as the kernel prints them on a little-endian machine, trailing columns cut.
const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
const tcp = [
  head,
  '   0: 0100007F:CD11 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1 0000000000000000 100 0 0 10 0',
  '   1: 00000000:1770 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5002 1 0000000000000000 100 0 0 10 0',
  '   2: 0201A8C0:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0000000000000000 100 0 0 10 0',
  '   3: 0100007F:CD11 0100007F:A000 01 00000000:00000000 00:00000000 00000000  1000        0 5004 1 0000000000000000 20 4 30 10 -1',
].join('\n')
const tcp6 = [
  head,
  '   0: 00000000000000000000000001000000:CD12 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6001 1 0000000000000000 100 0 0 10 0',
  '   1: 00000000000000000000000000000000:1771 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6002 1 0000000000000000 100 0 0 10 0',
  '   2: 0000000000000000FFFF00000100007F:1772 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6003 1 0000000000000000 100 0 0 10 0',
].join('\n')

describe('procListeners', () => {
  it('keeps only listening sockets on 127.0.0.1, with their port and inode', () => {
    expect(procListeners(tcp)).toEqual([{ inode: 5001, host: '127.0.0.1', port: 52497 }])
  })

  it('keeps ::1 and rejects any address and IPv4-mapped loopback in tcp6', () => {
    expect(procListeners(tcp6)).toEqual([{ inode: 6001, host: '::1', port: 52498 }])
  })
})

describe('socketInode', () => {
  it('reads the inode of a socket link and nothing else', () => {
    expect(socketInode('socket:[5001]')).toBe(5001)
    expect(socketInode('pipe:[5001]')).toBeUndefined()
    expect(socketInode('/dev/null')).toBeUndefined()
  })
})

describe('desktopPids', () => {
  it('matches the desktop app and its helpers by name, and marks Linux names cut to 15 characters', () => {
    const ps = [
      '  101 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      '  102 /Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper (Plugin).app/Contents/MacOS/DeepSeek Harness Helper (Plugin)',
      '  201 deepseek-harnes',
      '  202 DeepSeek Harnes',
      '  301 deepseek-harness-x',
      '  302 bash',
      'garbage',
    ].join('\n')
    expect(desktopPids(ps)).toEqual([
      { pid: 101, exact: true },
      { pid: 102, exact: true },
      { pid: 201, exact: false },
      { pid: 202, exact: false },
    ])
  })
})

describe('desktopListeners', () => {
  const procFiles = (exe: Record<number, string>, fds: Record<number, string[]>) => {
    fs.readFile.mockImplementation(async (path: string) => ({ '/proc/net/tcp': tcp, '/proc/net/tcp6': tcp6 })[path])
    fs.readdir.mockImplementation(async (path: string) => {
      const pid = Number(/^\/proc\/(\d+)\/fd$/.exec(path)?.[1])
      if (!fds[pid]) throw new Error('EACCES')
      return fds[pid]!.map((_, n) => String(n))
    })
    fs.readlink.mockImplementation(async (path: string) => {
      const [, pid, fd] = /^\/proc\/(\d+)\/(?:exe|fd\/(\d+))$/.exec(path) ?? []
      const link = fd === undefined ? exe[Number(pid)] : fds[Number(pid)]?.[Number(fd)]
      if (link === undefined) throw new Error('EACCES')
      return link
    })
  }

  it('on Linux, confirms a cut name by its executable and reads loopback listeners from /proc without lsof', async () => {
    onPlatform('linux')
    procFiles(
      { 201: '/opt/DeepSeek Harness/deepseek-harness', 202: '/usr/bin/impostor' },
      { 201: ['/dev/null', 'socket:[5001]', 'socket:[5002]', 'socket:[6001]', 'pipe:[5003]'], 202: ['socket:[5003]', 'socket:[6002]'] },
    )
    run.mockResolvedValue(output('  201 deepseek-harnes\n  202 deepseek-harnes\n  203 deepseek-harnes\n'))
    expect(await desktopListeners(new AbortController().signal)).toEqual([
      { pid: 201, origin: 'http://127.0.0.1:52497' },
      { pid: 201, origin: 'http://[::1]:52498' },
    ])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('on Linux, still knows the app after an upgrade replaced its executable', async () => {
    onPlatform('linux')
    procFiles({ 201: '/opt/DeepSeek Harness/deepseek-harness (deleted)' }, { 201: ['socket:[5001]'] })
    run.mockResolvedValue(output('  201 deepseek-harnes\n'))
    expect(await desktopListeners(new AbortController().signal)).toEqual([{ pid: 201, origin: 'http://127.0.0.1:52497' }])
  })

  it('on Linux without a readable /proc, asks lsof and keeps only loopback listeners', async () => {
    onPlatform('linux')
    procFiles({ 201: '/opt/DeepSeek Harness/deepseek-harness' }, {})
    fs.readFile.mockRejectedValue(new Error('ENOENT'))
    run.mockImplementation(async (command: string) =>
      output(
        command === 'ps'
          ? '  201 deepseek-harnes\n  202 deepseek-harnes\n'
          : 'p201\nf20\nn127.0.0.1:52497\nn*:6000\nn0.0.0.0:7000\nn192.168.1.2:8000\nn[::1]:52498\n',
      ),
    )
    expect(await desktopListeners(new AbortController().signal)).toEqual([
      { pid: 201, origin: 'http://127.0.0.1:52497' },
      { pid: 201, origin: 'http://[::1]:52498' },
    ])
    expect(run).toHaveBeenLastCalledWith('lsof', ['-nP', '-a', '-p', '201', '-iTCP', '-sTCP:LISTEN', '-Fpn'], expect.anything())
  })

  it('on macOS, asks lsof for the listeners of the named app', async () => {
    onPlatform('darwin')
    run.mockImplementation(async (command: string) =>
      output(
        command === 'ps'
          ? '  101 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness\n'
          : 'p101\nf20\nn127.0.0.1:52497\nn*:6000\n',
      ),
    )
    expect(await desktopListeners(new AbortController().signal)).toEqual([{ pid: 101, origin: 'http://127.0.0.1:52497' }])
    expect(fs.readFile).not.toHaveBeenCalledWith('/proc/net/tcp', expect.anything())
  })

  it('asks for no sockets when no process is the desktop app', async () => {
    onPlatform('linux')
    fs.readlink.mockRejectedValue(new Error('EACCES'))
    run.mockResolvedValue(output('  201 deepseek-harnes\n  302 bash\n'))
    expect(await desktopListeners(new AbortController().signal)).toEqual([])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('on Windows, reads PowerShell rows and drops anything not on loopback', async () => {
    onPlatform('win32')
    run.mockResolvedValue(output('101 127.0.0.1 52497\r\n101 0.0.0.0 6000\r\n102 ::1 52498\r\nbad\r\n'))
    expect(await desktopListeners(new AbortController().signal)).toEqual([
      { pid: 101, origin: 'http://127.0.0.1:52497' },
      { pid: 102, origin: 'http://[::1]:52498' },
    ])
    expect(run.mock.calls[0]![0]).toBe('powershell.exe')
  })
})

describe.runIf(platform !== 'win32')('pairingFor', () => {
  const dir = useTempDataRoot()
  const listeners = [{ pid: 101, origin: 'http://127.0.0.1:52497' }]
  const url = 'http://127.0.0.1:52497/?token=abc'
  const write = (row: object, mode = 0o600, name = 'dsh-desktop-live.json') => {
    const path = join(dir(), name)
    writeFileSync(path, JSON.stringify(row))
    chmodSync(path, mode)
    return path
  }
  const live = { version: 1, pid: 101, pairingUrl: url }

  it('reads the pairing address of the running desktop app from a private file', async () => {
    write(live)
    expect(await pairingFor(listeners)).toBe(url)
  })

  it('refuses a file others can read, a hard link and a symlink', async () => {
    const path = write(live, 0o644)
    expect(await pairingFor(listeners)).toBeUndefined()
    chmodSync(path, 0o600)
    linkSync(path, join(dir(), 'link.json'))
    expect(await pairingFor(listeners)).toBeUndefined()
    unlinkSync(join(dir(), 'link.json'))
    expect(await pairingFor(listeners)).toBe(url)
    renameSync(path, join(dir(), 'elsewhere.json'))
    symlinkSync(join(dir(), 'elsewhere.json'), path)
    expect(await pairingFor(listeners)).toBeUndefined()
  })

  it('refuses a file replaced between the check and the read', async () => {
    const path = write(live)
    const swap = write(live, 0o600, 'swap.json')
    fs.lstat.mockImplementationOnce(async (target: string) => {
      const before = await lstat(target)
      renameSync(swap, path)
      return before
    })
    expect(await pairingFor(listeners)).toBeUndefined()
  })

  it('refuses another process, another port, a remote address and an unknown version', async () => {
    for (const row of [
      { ...live, pid: 202 },
      { ...live, pairingUrl: 'http://127.0.0.1:1/?token=abc' },
      { ...live, pairingUrl: 'http://10.0.0.5:52497/?token=abc' },
      { ...live, version: 2 },
    ]) {
      write(row)
      expect(await pairingFor(listeners)).toBeUndefined()
    }
  })
})
