import { describe, expect, it } from 'vitest'
import { packageProgress, parseSize, pipHasRawProgress, throttledProgress } from '@main/lib/packageProgress'
import type { PackageInstallProgress } from '@shared/types'

const feedAll = (lines: string[]): PackageInstallProgress => {
  const tracker = packageProgress()
  for (const line of lines) tracker.feed(line)
  return tracker.current()
}

describe('main/lib/packageProgress', () => {
  it('reads the sizes pip and uv print', () => {
    expect(parseSize('2.9 GB')).toBe(2_900_000_000)
    expect(parseSize('2.4GiB')).toBe(Math.round(2.4 * 1024 ** 3))
    expect(parseSize('512.3 kB')).toBe(512_300)
    expect(parseSize('soon')).toBeNull()
  })

  it('follows pip: the file being fetched, its raw progress, and how many are done', () => {
    // Recorded from pip 26 with --progress-bar raw, off a terminal.
    const tracker = packageProgress()
    tracker.feed('Looking in indexes: https://download.pytorch.org/whl/cu130')
    tracker.feed('Collecting torch<2.15,>=2.13')
    expect(tracker.feed('  Downloading torch-2.14.1%2Bcu130-cp312-cp312-win_amd64.whl (2900.0 MB)')).toEqual({
      stage: 'download',
      package: 'torch',
      bytes: 2_900_000_000,
      percent: null,
      downloaded: 0,
    })
    expect(tracker.feed('Progress 1450000000 of 2900000000')?.percent).toBe(50)
    // The same percentage again changes nothing.
    expect(tracker.feed('Progress 1450000001 of 2900000000')).toBeNull()
    expect(tracker.feed('Collecting sympy>=1.13.3 (from torch<2.15,>=2.13)')).toBeNull()
    expect(tracker.feed('  Downloading sympy-1.14.0-py3-none-any.whl (6.3 MB)')).toMatchObject({
      package: 'sympy',
      downloaded: 1,
      percent: null,
    })
    tracker.feed('Progress 0 of 6299952')
    tracker.feed('Progress 6299952 of 6299952')
    // The last file counts once, also when it reached 100 %.
    expect(tracker.feed('Installing collected packages: sympy, torch')).toMatchObject({ stage: 'install', package: null, downloaded: 2 })
  })

  it('follows uv, which names a package with its size and again when it is done', () => {
    // Recorded from uv 0.9.7 off a terminal (stderr).
    const tracker = packageProgress()
    tracker.feed('Resolved 30 packages in 1.24s')
    expect(tracker.feed('Downloading torch (2.4GiB)')).toMatchObject({
      package: 'torch',
      bytes: Math.round(2.4 * 1024 ** 3),
      downloaded: 0,
    })
    tracker.feed('Downloading nvidia-cudnn-cu12 (634.0MiB)')
    expect(tracker.feed(' Downloading nvidia-cudnn-cu12')).toMatchObject({ package: 'nvidia-cudnn-cu12', percent: 100, downloaded: 1 })
    expect(tracker.feed(' Downloading torch')).toMatchObject({ downloaded: 2 })
    expect(tracker.feed('Prepared 30 packages in 2m 10s')).toMatchObject({ stage: 'install', downloaded: 2 })
    // Older uvs said "Downloaded".
    expect(feedAll(['Downloading numpy (15.0MiB)', 'Downloaded numpy']).downloaded).toBe(1)
  })

  it('reads a file name that is not valid URL encoding as it is', () => {
    expect(feedAll(['Downloading weird%zz-1.0-py3-none-any.whl (1.0 MB)']).package).toBe('weird%zz')
  })

  it('asks pip for raw progress only from 24.1 on', () => {
    expect(pipHasRawProgress('pip 24.1 from /venv/lib/python3.12/site-packages/pip (python 3.12)')).toBe(true)
    expect(pipHasRawProgress('pip 25.0.1 from …')).toBe(true)
    expect(pipHasRawProgress('pip 24.0 from …')).toBe(false)
    expect(pipHasRawProgress('No module named pip')).toBe(false)
  })

  it('passes progress on at most every interval, but always when the package changes', () => {
    let clock = 0
    const seen: PackageInstallProgress[] = []
    const report = throttledProgress(
      (progress) => seen.push(progress),
      250,
      () => clock,
    )
    const at = (pkg: string, percent: number): PackageInstallProgress => ({
      stage: 'download',
      package: pkg,
      bytes: null,
      percent,
      downloaded: 0,
    })
    report(at('torch', 1))
    clock = 100
    report(at('torch', 2))
    clock = 120
    report(at('sympy', 0))
    clock = 400
    report(at('sympy', 50))
    expect(seen.map((item) => `${item.package}:${item.percent}`)).toEqual(['torch:1', 'sympy:0', 'sympy:50'])
  })
})
