import { readlink } from 'node:fs/promises'
import { homedir } from 'node:os'

/**
 * Variables a model path in another app's config may use. Anything else stays
 * unexpanded, so a planted config cannot pull a secret such as a token into a
 * path the app then opens.
 */
const PATH_VARIABLES = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']

/** Paths compare case-insensitively on Windows. */
export function modelPathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function pathVariable(name: string): string | undefined {
  const known = PATH_VARIABLES.find((item) => (process.platform === 'win32' ? item.toLowerCase() === name.toLowerCase() : item === name))
  if (!known) return undefined
  return known === 'HOME' ? homedir() : process.env[known]
}

/** Expands `~` and the allowed variables in `${X}`, `$X` and `%X%` form; other variables are left as written. */
export function expandPathVariables(path: string): string {
  return path
    .replace(/^~(?=$|[\\/])/, homedir())
    .replace(
      /\$\{([^}]{1,64})\}|\$([A-Za-z_][A-Za-z0-9_]{0,63})|%([^%]{1,64})%/g,
      (match: string, braced?: string, plain?: string, windows?: string) => pathVariable(braced ?? plain ?? windows ?? '') ?? match,
    )
}

/**
 * A path that opening would send over the network: UNC shares (also WebDAV `\\host@SSL\…`),
 * `\\?\` and `\\.\` device paths, NT `\??\` paths (which `realpath` hands to Windows unchanged),
 * and URLs. Opening one on Windows authenticates with the
 * person's NTLM hash, so only a folder the person picked may be one.
 */
export function isNetworkPath(path: string): boolean {
  return /^(?:[\\/]{2}|\\\?\?\\)/.test(path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
}

/** Whether a link points at a network place, read without opening the target, so the share is never contacted. */
export async function linksToNetwork(path: string): Promise<boolean> {
  const target = await readlink(path).catch(() => null)
  return target !== null && isNetworkPath(target)
}
