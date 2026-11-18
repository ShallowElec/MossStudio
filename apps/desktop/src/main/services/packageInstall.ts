import type { PackageInstallProgress } from '@shared/types'
import { packageProgress, pipHasRawProgress, throttledProgress } from '../lib/packageProgress'
import { run, runStream, type RunResult } from '../lib/run'

export interface PackageInstall {
  /** The venv's Python. */
  python: string
  /** Install with uv (`uv pip install --python`) instead of the venv's pip. */
  uv: boolean
  /** Absent: the tool's own configuration (pip.conf, uv.toml) decides. */
  indexUrl?: string
  /** Packages and pip arguments after the index, such as `-e <dir>`. */
  packages: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  onProgress?: (progress: PackageInstallProgress) => void
}

/**
 * One `pip install` (or `uv pip install`) that reports the download as it
 * goes. pip prints a percentage only with `--progress-bar raw`, which older
 * pips refuse, so it is asked for only when the venv's pip knows it.
 */
export async function installPackages(input: PackageInstall): Promise<RunResult> {
  const tracker = packageProgress()
  const report = input.onProgress ? throttledProgress(input.onProgress) : null
  const onLine = (line: string, stream: 'stdout' | 'stderr'): void => {
    input.onLine?.(line, stream)
    const progress = tracker.feed(line)
    if (progress && report) report(progress)
  }
  const options = { cwd: input.cwd, env: input.env, timeoutMs: input.timeoutMs, signal: input.signal }
  const index = input.indexUrl ? ['--index-url', input.indexUrl] : []
  if (input.uv) return runStream('uv', ['pip', 'install', '--python', input.python, ...index, ...input.packages], options, onLine)
  const version = await run(input.python, ['-m', 'pip', '--version'], { timeoutMs: 30_000 })
  const raw = version.code === 0 && pipHasRawProgress(version.stdout) ? ['--progress-bar', 'raw'] : []
  return runStream(input.python, ['-m', 'pip', 'install', ...raw, ...index, ...input.packages], options, onLine)
}
