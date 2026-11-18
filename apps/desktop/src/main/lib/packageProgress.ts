import type { PackageInstallProgress } from '@shared/types'

/**
 * Follows the output of `pip install` or `uv pip install` and says how the
 * download is going: which package is being fetched, its size, how far
 * (pip's `--progress-bar raw` only; uv prints no percentages off a terminal)
 * and how many packages are done. Pure, so it is tested on recorded lines.
 */

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
}

/** "2.9 GB", "2.4GiB", "512.3 kB" → bytes. */
export function parseSize(text: string): number | null {
  const match = /^([\d.]+)\s*([kmg]i?b|b)$/i.exec(text.trim())
  if (!match) return null
  const value = Number.parseFloat(match[1]!)
  const unit = UNITS[match[2]!.toLowerCase()]
  return Number.isFinite(value) && unit ? Math.round(value * unit) : null
}

/** The package a wheel or sdist belongs to: "torch-2.9.0%2Bcu128-cp312-…whl" → "torch". */
function packageOfFile(file: string): string {
  let name = file.split('/').pop() ?? file
  try {
    name = decodeURIComponent(name)
  } catch {
    // A stray % in a file name: the name is read as it is.
  }
  return name.split('-')[0] ?? name
}

export interface PackageProgressTracker {
  /** Feeds one output line; answers the new state when the line changed it. */
  feed: (line: string) => PackageInstallProgress | null
  current: () => PackageInstallProgress
}

export function packageProgress(): PackageProgressTracker {
  let state: PackageInstallProgress = { stage: 'download', package: null, bytes: null, percent: null, downloaded: 0 }
  /** pip names no end of a file: one under way is counted when the next starts or the install begins. */
  let pipFileOpen = false
  const set = (next: Partial<PackageInstallProgress>): PackageInstallProgress => {
    state = { ...state, ...next }
    return state
  }
  const feed = (raw: string): PackageInstallProgress | null => {
    const line = raw.trim()
    // pip: "Downloading torch-2.14.1%2Bcu130-cp312-cp312-win_amd64.whl (2900.0 MB)" (a URL in older pips).
    let match = /^Downloading\s+(\S+\.(?:whl|tar\.gz|zip))(?:\s+\(([^)]+)\))?/.exec(line)
    if (match) {
      const downloaded = pipFileOpen ? state.downloaded + 1 : state.downloaded
      pipFileOpen = true
      return set({
        stage: 'download',
        package: packageOfFile(match[1]!),
        bytes: match[2] ? parseSize(match[2]) : null,
        percent: null,
        downloaded,
      })
    }
    // uv starts a file with its size, "Downloading torch (2.4GiB)", and ends it with " Downloading torch"
    // (older uvs: "Downloaded torch").
    match = /^Downloading\s+([A-Za-z0-9_.-]+)\s+\(([^)]+)\)$/.exec(line)
    if (match) return set({ stage: 'download', package: match[1]!, bytes: parseSize(match[2]!), percent: null })
    match = /^Download(?:ing|ed)\s+([A-Za-z0-9_.-]+)$/.exec(line)
    if (match) return set({ downloaded: state.downloaded + 1, percent: state.package === match[1] ? 100 : state.percent })
    // pip with --progress-bar raw: "Progress 1048576 of 2900000000".
    match = /^Progress\s+(\d+)\s+of\s+(\d+)$/.exec(line)
    if (match) {
      const total = Number(match[2])
      if (!total) return null
      const percent = Math.min(100, Math.floor((Number(match[1]) / total) * 100))
      return percent === state.percent ? null : set({ percent })
    }
    // Both tools say when they move from fetching to installing.
    if (/^Installing collected packages/.test(line) || /^Prepared \d+ packages?/.test(line)) {
      const downloaded = pipFileOpen ? state.downloaded + 1 : state.downloaded
      pipFileOpen = false
      return set({ stage: 'install', package: null, bytes: null, percent: null, downloaded })
    }
    return null
  }
  return { feed, current: () => state }
}

/** pip learned `--progress-bar raw` in 24.1; older ones refuse the option. */
export function pipHasRawProgress(versionOutput: string): boolean {
  const match = /pip (\d+)\.(\d+)/.exec(versionOutput)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 24 || (major === 24 && minor >= 1)
}

/**
 * Hands progress on at most every `intervalMs`, but always when the package
 * or stage changes, so a fast stream of raw progress lines does not flood the renderer.
 */
export function throttledProgress(
  report: (progress: PackageInstallProgress) => void,
  intervalMs = 250,
  now: () => number = Date.now,
): (progress: PackageInstallProgress) => void {
  let last = 0
  let previous: PackageInstallProgress | null = null
  return (progress) => {
    const changed = !previous || previous.package !== progress.package || previous.stage !== progress.stage
    if (!changed && now() - last < intervalMs) return
    last = now()
    previous = progress
    report(progress)
  }
}
