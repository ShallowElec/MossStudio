import { describe, expect, it } from 'vitest'
import { columnLabel, newestDrawnStep, sampleColumns, stepName } from '@renderer/pages/training/sampleGridModel'
import { samplesFixture } from '../../mocks/backend/training'

const prompts = ['juzi 在窗台上', 'juzi 在雪地里', 'juzi 的水彩画']

describe('sample grid columns', () => {
  it('names columns by step, 训练前 first', () => {
    expect(columnLabel(0)).toBe('训练前')
    expect(columnLabel(1250)).toBe('1,250 步')
    expect(stepName(2500)).toBe('第 2,500 步')
  })

  it('adds the steps still to come while running, with their time left', () => {
    const samples = samplesFixture('tp-juzi', prompts, [0, 250, 500], 750)
    const columns = sampleColumns({
      samples,
      chosenStep: null,
      sampleEvery: 250,
      totalSteps: 1000,
      running: { step: 500, etaMs: 500 * 1000 },
    })
    expect(columns.map((column) => [column.step, column.pending])).toEqual([
      [0, false],
      [250, false],
      [500, false],
      [750, true],
      [1000, true],
    ])
    expect(columns[3]!.pendingText).toBe('约 5 分钟')
    expect(columns[3]!.images).toEqual([null, null, null])
    expect(newestDrawnStep(columns)).toBe(500)
  })

  it('lets only steps with a checkpoint be chosen, and marks the chosen one', () => {
    const samples = samplesFixture('tp-mug', prompts, [0, 500, 1000])
    const columns = sampleColumns({ samples, chosenStep: 1000, sampleEvery: 500, totalSteps: 1000 })
    expect(columns.map((column) => column.choosable)).toEqual([false, true, true])
    expect(columns.map((column) => column.chosen)).toEqual([false, false, true])
    expect(columns.some((column) => column.pending)).toBe(false)
  })

  it('shows a checkpoint without samples as a column that can still be chosen', () => {
    const samples = { ...samplesFixture('tp-x', prompts, [0]), checkpoints: [500] }
    const columns = sampleColumns({ samples, chosenStep: null, sampleEvery: 0, totalSteps: 500 })
    expect(columns.map((column) => [column.step, column.choosable, column.images])).toEqual([
      [0, false, samples.columns[0]!.images],
      [500, true, [null, null, null]],
    ])
  })
})
