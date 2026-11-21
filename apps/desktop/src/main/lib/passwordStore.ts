import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Which keyring Electron's safeStorage uses on Linux. Electron picks one from the desktop
 * environment alone (os_crypt `SelectBackend` over Chromium's `GetDesktopEnvironment`), so a
 * desktop it does not know (Hyprland, Sway, i3, LXQt) gets `basic_text` and every token and
 * API key save is refused, even with gnome-keyring or KWallet running. There we look for a
 * keyring on the session bus and name it with `--password-store`, which Electron reads after
 * the main script runs and before app ready.
 */

/** Total wait for the bus, across both calls; the app is not ready to show anything yet. */
export const BUS_TIMEOUT_MS = 1500

export type PasswordStore = 'gnome-libsecret' | 'kwallet6' | 'kwallet5'

/**
 * Whether Electron picks a keyring for this desktop by itself. Mirrors `GetDesktopEnvironment`
 * in base/nix/xdg_util.cc and `SelectBackend` in Electron's os_crypt sync patch (Electron 45,
 * Chromium 156): only OTHER, KDE3 and LXQT land on basic_text.
 */
export function desktopPicksKeyring(env: NodeJS.ProcessEnv): boolean {
  for (const value of (env['XDG_CURRENT_DESKTOP'] ?? '').split(':').map((part) => part.trim())) {
    if (['Unity', 'Deepin', 'GNOME', 'X-Cinnamon', 'KDE', 'Pantheon', 'XFCE', 'UKUI', 'COSMIC'].includes(value)) return true
    if (value === 'LXQt') return false
  }
  const session = env['DESKTOP_SESSION'] ?? ''
  if (['deepin', 'gnome', 'mate', 'kde4', 'kde-plasma', 'xubuntu', 'ukui'].includes(session) || session.includes('xfce')) return true
  // KDE without KDE_SESSION_VERSION is KDE3, which has no D-Bus wallet.
  if (session === 'kde') return env['KDE_SESSION_VERSION'] !== undefined
  if (env['GNOME_DESKTOP_SESSION_ID'] !== undefined) return true
  if (env['KDE_FULL_SESSION'] !== undefined) return env['KDE_SESSION_VERSION'] !== undefined
  return false
}

/**
 * The session bus address, or null when there is none to ask. Without one, dbus-send would
 * autolaunch a bus daemon that outlives the call.
 */
function busAddress(env: NodeJS.ProcessEnv): string | null {
  const address = env['DBUS_SESSION_BUS_ADDRESS']
  if (address) return address
  const runtime = env['XDG_RUNTIME_DIR']
  return runtime && existsSync(join(runtime, 'bus')) ? `unix:path=${join(runtime, 'bus')}` : null
}

/**
 * Names on the session bus that are owned or can be started on demand (gnome-keyring and
 * KeePassXC are often D-Bus activated), or null when the bus cannot be asked. Synchronous
 * because it runs before app ready; the timeout and SIGKILL end dbus-send within the call.
 */
export function sessionBusNames(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const address = busAddress(env)
  if (!address) return null
  const names = new Set<string>()
  try {
    for (const method of ['ListNames', 'ListActivatableNames']) {
      const output = execFileSync(
        'dbus-send',
        ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', `org.freedesktop.DBus.${method}`],
        {
          encoding: 'utf8',
          env: { ...env, DBUS_SESSION_BUS_ADDRESS: address },
          timeout: BUS_TIMEOUT_MS / 2,
          killSignal: 'SIGKILL',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      )
      for (const match of output.matchAll(/string "([^"]+)"/g)) names.add(match[1]!)
    }
  } catch {
    // No dbus-send, no bus, or no answer in time: Electron keeps its own choice.
    return null
  }
  return names
}

/** The `--password-store` to add, or null to leave Electron's choice alone. */
export function choosePasswordStore(input: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  hasSwitch: boolean
  busNames: () => Set<string> | null
}): PasswordStore | null {
  if (input.platform !== 'linux' || input.hasSwitch || desktopPicksKeyring(input.env)) return null
  const names = input.busNames()
  if (!names) return null
  if (names.has('org.freedesktop.secrets')) return 'gnome-libsecret'
  if (names.has('org.kde.kwalletd6')) return 'kwallet6'
  if (names.has('org.kde.kwalletd5')) return 'kwallet5'
  return null
}

/** Call before app ready. A `--password-store` the user passed always wins. */
export function configurePasswordStore(): PasswordStore | null {
  const store = choosePasswordStore({
    platform: process.platform,
    env: process.env,
    hasSwitch: app.commandLine.hasSwitch('password-store'),
    busNames: () => sessionBusNames(),
  })
  if (store) app.commandLine.appendSwitch('password-store', store)
  return store
}
