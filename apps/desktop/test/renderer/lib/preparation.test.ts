import { describe, expect, it } from 'vitest'
import { localModelTasks, preparationAmount, preparationProgress, timeLeftLabel } from '@renderer/lib/preparation'
import { downloadFixture, engineDownloadFixture } from '../../mocks/backend/fixtures'

const MB = 1_000_000

describe('preparationProgress', () => {
  it('is null when nothing is being prepared', () => {
    expect(preparationProgress(null, [])).toBeNull()
  })

  it('adds the engine and the model files into one number, with the combined speed and time left', () => {
    const engine = engineDownloadFixture({ phase: 'downloading', bytes: 100 * MB, totalBytes: 200 * MB, speedBps: 10 * MB })
    const tasks = [
      downloadFixture({ targetId: 'dit', state: 'running', bytes: 300 * MB, totalBytes: 600 * MB, speedBps: 20 * MB }),
      downloadFixture({ targetId: 'vae', state: 'queued', bytes: 0, totalBytes: 200 * MB, speedBps: 0 }),
    ]
    const progress = preparationProgress(engine, tasks)!
    expect(progress).toMatchObject({ done: 400 * MB, total: 1000 * MB, percent: 40, speedBps: 30 * MB, active: true, failed: false })
    expect(progress.secondsLeft).toBe(20)
    expect(progress.parts.map((part) => part.id)).toEqual(['engine', 'model'])
  })

  it('counts finished files whole and an installed engine as done', () => {
    const engine = engineDownloadFixture({ phase: 'done', bytes: 200 * MB, totalBytes: 200 * MB, percent: 100 })
    const tasks = [
      downloadFixture({ targetId: 'dit', state: 'done', bytes: 0, totalBytes: 600 * MB }),
      downloadFixture({ targetId: 'vae', state: 'running', bytes: 100 * MB, totalBytes: 200 * MB, speedBps: 50 * MB }),
    ]
    const progress = preparationProgress(engine, tasks)!
    expect(progress.done).toBe(900 * MB)
    expect(progress.parts[0]).toMatchObject({ id: 'engine', finished: true })
    expect(progress.secondsLeft).toBe(2)
  })

  it('counts the engine packages of a multi-GPU install one after another', () => {
    const engine = engineDownloadFixture({
      phase: 'downloading',
      bytes: 50 * MB,
      totalBytes: 100 * MB,
      speedBps: 0,
      step: { index: 1, count: 2, packageId: 'cu12' },
    })
    expect(preparationProgress(engine, [])!).toMatchObject({ done: 150 * MB, total: 200 * MB, secondsLeft: null })
  })

  it('says when a part stopped, and is no longer active once nothing runs', () => {
    const tasks = [downloadFixture({ state: 'error', bytes: 10 * MB, totalBytes: 600 * MB, error: '网络中断' })]
    expect(preparationProgress(null, tasks)).toMatchObject({ active: false, failed: true, secondsLeft: null })
  })

  it('leaves out downloads for remote hosts', () => {
    const tasks = [downloadFixture({ targetId: 'a' }), downloadFixture({ targetId: 'b', hostId: 'ssh-1' })]
    expect(localModelTasks(tasks).map((task) => task.targetId)).toEqual(['a'])
  })
})

describe('timeLeftLabel', () => {
  it('reads like a person would say it', () => {
    expect(timeLeftLabel(null)).toBeNull()
    expect(timeLeftLabel(20)).toBe('不到 1 分钟')
    expect(timeLeftLabel(17 * 60 + 5)).toBe('约 18 分钟')
    expect(timeLeftLabel(3600)).toBe('约 1 小时')
    expect(timeLeftLabel(80 * 60)).toBe('约 1 小时 20 分钟')
  })
})

describe('preparationProgress with a failed part', () => {
  it('counts only what arrived of a failed engine package, while the model keeps going', () => {
    const engine = engineDownloadFixture({ phase: 'error', bytes: 50 * MB, totalBytes: 200 * MB, error: 'x' })
    const tasks = [downloadFixture({ targetId: 'dit', state: 'running', bytes: 100 * MB, totalBytes: 600 * MB, speedBps: 20 * MB })]
    const progress = preparationProgress(engine, tasks)!
    expect(progress).toMatchObject({ done: 150 * MB, total: 800 * MB, active: true, failed: true })
    expect(progress.parts[0]).toMatchObject({ id: 'engine', done: 50 * MB, failed: true, finished: false })
  })
})

describe('preparationAmount', () => {
  it('says 准备中 until the first bytes arrive, never 未知', () => {
    expect(preparationAmount(0, 25 * 1024 ** 3)).toBe('准备中')
    expect(preparationAmount(0, 0)).toBe('准备中')
  })

  it('reads done of total once bytes arrive', () => {
    expect(preparationAmount(3 * 1024 ** 3, 25 * 1024 ** 3)).toBe('3.0 GB / 25 GB')
  })
})
