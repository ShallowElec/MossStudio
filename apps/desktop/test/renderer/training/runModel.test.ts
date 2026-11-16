import { describe, expect, it } from 'vitest'
import { curvePath, lossCurve, runPill, runProgress } from '@renderer/pages/training/runModel'
import { trainingJobFixture, trainingProjectFixture } from '../../mocks/backend/training'

const project = trainingProjectFixture({ state: 'running', jobId: 'job-tp-juzi' })

describe('run progress', () => {
  it('reads steps, time left and loss from the job', () => {
    const progress = runProgress(project, trainingJobFixture(project))
    expect(progress).toMatchObject({ step: 1250, total: 3000, loss: 0.084 })
    expect(progress.percent).toBeCloseTo(41.67, 1)
    expect(progress.text).toBe('1,250 / 3,000 步 · 还要约 24 分钟')
  })

  it('moves the bar instead of guessing before the first step', () => {
    const job = trainingJobFixture(project, {
      state: 'queued',
      metrics: { step: 0 },
      progress: { stage: 'idle', current: 0, total: 0, percent: 0 },
    })
    expect(runProgress({ ...project, stepReached: 0 }, job)).toMatchObject({ percent: null, text: '排队中', total: 3000 })
    expect(runProgress({ ...project, stepReached: 0 }, undefined).text).toBe('正在启动…')
  })
})

describe('a training that is starting', () => {
  it('says the pictures are being prepared, with a moving bar and nothing counted', () => {
    expect(runProgress({ ...project, state: 'starting', stepReached: 0 }, undefined)).toEqual({
      step: 0,
      total: 3000,
      percent: null,
      etaMs: null,
      text: '正在准备图片…',
      loss: null,
    })
    expect(runPill('starting')).toBe('准备中')
    expect(runPill('running')).toBe('训练中')
  })
})

describe('loss curve', () => {
  it('keeps one point per new step of a job', () => {
    const job = trainingJobFixture(project, { id: 'job-curve' })
    lossCurve({ ...job, metrics: { step: 10, loss: 0.3 } })
    lossCurve({ ...job, metrics: { step: 10, loss: 0.29 } })
    const points = lossCurve({ ...job, metrics: { step: 20, loss: 0.2 } })
    expect(points).toEqual([
      { step: 10, loss: 0.3 },
      { step: 20, loss: 0.2 },
    ])
  })

  it('draws higher loss higher up, and nothing for a single point', () => {
    expect(curvePath([{ step: 1, loss: 1 }], 100, 10)).toBe('')
    expect(
      curvePath(
        [
          { step: 0, loss: 1 },
          { step: 10, loss: 0 },
        ],
        100,
        10,
      ),
    ).toBe('M0.0 0.0 L100.0 10.0')
  })
})
