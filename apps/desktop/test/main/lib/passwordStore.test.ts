import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDir } from '@test/helpers/tempDir'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), execFileSync }))

const { BUS_TIMEOUT_MS, choosePasswordStore, configurePasswordStore, desktopPicksKeyring, sessionBusNames } =
  await import('@main/lib/passwordStore')

const bus = 'unix:path=/run/user/1000/bus'
const hyprland = { XDG_CURRENT_DESKTOP: 'Hyprland', DBUS_SESSION_BUS_ADDRESS: bus }
const reply = (...names: string[]) =>
  `method return time=1 sender=org.freedesktop.DBus\n   array [\n${names.map((name) => `      string "${name}"`).join('\n')}\n   ]\n`

/** Answers ListNames with `owned` and ListActivatableNames with `activatable`. */
function busWith(owned: string[], activatable: string[] = []): void {
  execFileSync.mockImplementation((_command: string, args: string[]) =>
    reply(...(args.at(-1)!.endsWith('ListActivatableNames') ? activatable : owned)),
  )
}

const decide = (env: NodeJS.ProcessEnv, hasSwitch = false, platform: NodeJS.Platform = 'linux') =>
  choosePasswordStore({ platform, env, hasSwitch, busNames: () => sessionBusNames(env) })

beforeEach(() => {
  execFileSync.mockReset()
})

describe('which desktops Electron gives a keyring by itself', () => {
  it.each([
    [{ XDG_CURRENT_DESKTOP: 'GNOME' }],
    [{ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }],
    [{ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' }],
    [{ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }],
    [{ XDG_CURRENT_DESKTOP: 'XFCE' }],
    [{ XDG_CURRENT_DESKTOP: 'COSMIC' }],
    [{ XDG_CURRENT_DESKTOP: 'Hyprland:GNOME' }],
    [{ DESKTOP_SESSION: 'mate' }],
    [{ DESKTOP_SESSION: 'xfce4' }],
    [{ DESKTOP_SESSION: 'kde', KDE_SESSION_VERSION: '5' }],
    [{ GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' }],
  ])('picks one for %o', (env) => {
    expect(desktopPicksKeyring(env)).toBe(true)
  })

  it.each([
    [{ XDG_CURRENT_DESKTOP: 'Hyprland' }],
    [{ XDG_CURRENT_DESKTOP: 'sway' }],
    [{ XDG_CURRENT_DESKTOP: 'i3' }],
    // LXQt is a known desktop that Electron still sends to basic_text.
    [{ XDG_CURRENT_DESKTOP: 'LXQt', DESKTOP_SESSION: 'gnome' }],
    // KDE3 had no D-Bus wallet.
    [{ DESKTOP_SESSION: 'kde' }],
    [{ KDE_FULL_SESSION: 'true' }],
    [{}],
  ])('falls back to basic_text for %o', (env) => {
    expect(desktopPicksKeyring(env)).toBe(false)
  })
})

describe('choosing --password-store', () => {
  it('names the Secret Service on a desktop Electron does not know', () => {
    busWith(['org.freedesktop.DBus', 'org.freedesktop.secrets'])
    expect(decide(hyprland)).toBe('gnome-libsecret')
  })

  it('names the Secret Service when it is only D-Bus activatable', () => {
    busWith(['org.freedesktop.DBus'], ['org.freedesktop.secrets'])
    expect(decide(hyprland)).toBe('gnome-libsecret')
  })

  it('falls back to KWallet when there is no Secret Service, newest first', () => {
    busWith([], ['org.kde.kwalletd5', 'org.kde.kwalletd6'])
    expect(decide(hyprland)).toBe('kwallet6')
    busWith(['org.kde.kwalletd5'])
    expect(decide(hyprland)).toBe('kwallet5')
  })

  it('leaves Electron alone when the bus has no keyring', () => {
    busWith(['org.freedesktop.DBus', 'org.freedesktop.Notifications'])
    expect(decide(hyprland)).toBeNull()
  })

  it('does not ask the bus for a desktop Electron recognises, for a user switch, or off Linux', () => {
    busWith(['org.freedesktop.secrets'])
    expect(decide({ ...hyprland, XDG_CURRENT_DESKTOP: 'GNOME' })).toBeNull()
    expect(decide(hyprland, true)).toBeNull()
    expect(decide(hyprland, false, 'win32')).toBeNull()
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('skips quietly when dbus-send is missing', () => {
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync dbus-send ENOENT'), { code: 'ENOENT' })
    })
    expect(decide(hyprland)).toBeNull()
  })

  it('skips quietly when the bus does not answer in time', () => {
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync dbus-send ETIMEDOUT'), { code: 'ETIMEDOUT' })
    })
    expect(decide(hyprland)).toBeNull()
  })

  it('does not start dbus-send without a session bus, so it cannot autolaunch one', () => {
    expect(decide({ XDG_CURRENT_DESKTOP: 'Hyprland' })).toBeNull()
    expect(execFileSync).not.toHaveBeenCalled()
  })
})

describe('asking the session bus', () => {
  const runtime = useTempDir()

  it('bounds every call with a timeout and SIGKILL, within the total budget', () => {
    busWith(['org.freedesktop.secrets'])
    sessionBusNames(hyprland)
    expect(execFileSync).toHaveBeenCalledTimes(2)
    let total = 0
    for (const [command, , options] of execFileSync.mock.calls as Array<[string, string[], { timeout: number; killSignal: string }]>) {
      expect(command).toBe('dbus-send')
      expect(options.killSignal).toBe('SIGKILL')
      expect(options.timeout).toBeGreaterThan(0)
      total += options.timeout
    }
    expect(total).toBeLessThanOrEqual(BUS_TIMEOUT_MS)
  })

  it('finds the bus socket in XDG_RUNTIME_DIR and hands its address to dbus-send', () => {
    mkdirSync(runtime(), { recursive: true })
    writeFileSync(join(runtime(), 'bus'), '')
    busWith(['org.freedesktop.secrets'])
    expect(sessionBusNames({ XDG_RUNTIME_DIR: runtime() })?.has('org.freedesktop.secrets')).toBe(true)
    const options = execFileSync.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }
    expect(options.env['DBUS_SESSION_BUS_ADDRESS']).toBe(`unix:path=${join(runtime(), 'bus')}`)
  })
})

describe('configurePasswordStore', () => {
  it('appends the switch Electron reads, and never replaces one the user passed', async () => {
    const { app } = await import('electron')
    const append = vi.spyOn(app.commandLine, 'appendSwitch')
    const has = vi.spyOn(app.commandLine, 'hasSwitch').mockReturnValue(false)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('XDG_CURRENT_DESKTOP', 'Hyprland')
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', bus)
    busWith(['org.freedesktop.secrets'])
    expect(configurePasswordStore()).toBe('gnome-libsecret')
    expect(append).toHaveBeenCalledWith('password-store', 'gnome-libsecret')
    append.mockClear()
    has.mockReturnValue(true)
    expect(configurePasswordStore()).toBeNull()
    expect(append).not.toHaveBeenCalled()
    expect(has).toHaveBeenCalledWith('password-store')
  })
})
