import { describe, expect, it } from 'vitest'
import {
  MAX_ATTEMPTS,
  applyJob,
  approve,
  chapterPanels,
  chapterProgress,
  dequeue,
  enqueue,
  markSubmitFailed,
  markSubmitted,
  nextToSubmit,
  reconcile,
  reject,
  updatePanel,
} from '@shared/manga/queue'
import type { MangaSeries } from '@shared/manga/model'
import { mangaPanelFixture, mangaSeriesFixture } from '../../mocks/backend/manga'

const panelsOf = (series: MangaSeries) => chapterPanels(series.chapters[0]!)
const output = { path: '/out/1.png', width: 1024, height: 768, seed: 7 }

describe('the drawing queue', () => {
  it('queues every panel that still needs a picture, skipping empty ones', () => {
    let series = mangaSeriesFixture()
    series = updatePanel(series, 'chapter-1', 'panel-3', (panel) => ({ ...panel, scene: '' }))
    series = updatePanel(series, 'chapter-1', 'panel-2', (panel) => ({ ...panel, state: 'approved' }))
    const queued = enqueue(series, 'chapter-1')
    expect(panelsOf(queued).map((panel) => panel.state)).toEqual(['queued', 'approved', 'draft'])
    // Named panels are drawn again even when approved.
    expect(panelsOf(enqueue(series, 'chapter-1', ['panel-2']))[1]!.state).toBe('queued')
  })

  it('sends at most two at a time, in reading order', () => {
    const series = enqueue(mangaSeriesFixture(), 'chapter-1')
    expect(nextToSubmit(series.chapters[0]!).map((panel) => panel.id)).toEqual(['panel-1', 'panel-2'])
    const running = updatePanel(series, 'chapter-1', 'panel-1', (panel) => markSubmitted(panel, 'job-1'))
    expect(nextToSubmit(running.chapters[0]!).map((panel) => panel.id)).toEqual(['panel-2'])
  })

  it('stops what is still waiting, and leaves drawn panels in review', () => {
    let series = enqueue(mangaSeriesFixture(), 'chapter-1')
    series = updatePanel(series, 'chapter-1', 'panel-2', (panel) => ({ ...panel, takes: [{ ...output, jobId: 'j' }] }))
    expect(panelsOf(dequeue(series, 'chapter-1')).map((panel) => panel.state)).toEqual(['draft', 'review', 'draft'])
  })
})

describe('a job ending', () => {
  const running = markSubmitted(mangaPanelFixture('p', { state: 'queued' }), 'job-1')

  it('puts a finished picture up for review', () => {
    const done = applyJob(running, { id: 'job-1', state: 'succeeded', outputs: [output] })
    expect(done).toMatchObject({ state: 'review', jobId: undefined, attempts: 0 })
    expect(done.takes).toEqual([{ ...output, jobId: 'job-1' }])
  })

  it('retries a failed run until it gives up', () => {
    let panel = running
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      panel = applyJob(panel, { id: 'job-1', state: 'failed', error: { code: 'E', message: '显存不够' } })
      expect(panel).toMatchObject({ state: 'queued', attempts: attempt, error: '显存不够' })
      panel = markSubmitted(panel, 'job-1')
      // While the retry runs, the failure it retries is still shown.
      expect(panel).toMatchObject({ state: 'running', error: '显存不够' })
    }
    panel = applyJob(panel, { id: 'job-1', state: 'failed' })
    expect(panel).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS, error: '生成失败了' })
  })

  it('does not retry a run a person stopped, nor a submit that cannot work', () => {
    expect(applyJob(running, { id: 'job-1', state: 'canceled' }).state).toBe('draft')
    expect(markSubmitFailed(running, '还没有可用的模型', false)).toMatchObject({ state: 'failed', error: '还没有可用的模型' })
    expect(markSubmitFailed(running, '生成服务还在启动').state).toBe('queued')
  })

  it('ignores other jobs, and counts a success without pictures as a failure', () => {
    expect(applyJob(running, { id: 'job-2', state: 'succeeded', outputs: [output] })).toBe(running)
    expect(applyJob(running, { id: 'job-1', state: 'succeeded', outputs: [] })).toMatchObject({ state: 'queued', attempts: 1 })
  })
})

describe('review', () => {
  const inReview = mangaPanelFixture('p', {
    state: 'review',
    takes: [
      { ...output, jobId: 'a' },
      { ...output, seed: 8, jobId: 'b' },
    ],
  })

  it('approves one take, and sends a panel back with what to change', () => {
    expect(approve(inReview, 0)).toMatchObject({ state: 'approved', chosen: 0 })
    expect(approve(inReview, 5)).toBe(inReview)
    expect(reject(inReview, ' 背景换成白天 ')).toMatchObject({ state: 'queued', note: '背景换成白天', attempts: 0 })
  })

  it('counts panels by state', () => {
    const series = updatePanel(enqueue(mangaSeriesFixture(), 'chapter-1'), 'chapter-1', 'panel-1', () => approve(inReview, 1))
    expect(chapterProgress(series.chapters[0]!)).toEqual({ draft: 0, queued: 2, running: 0, review: 0, approved: 1, failed: 0, total: 3 })
  })
})

describe('reconcile', () => {
  it('catches up with jobs that ended while nobody watched, and fails a job that is gone', () => {
    let series = mangaSeriesFixture()
    series = updatePanel(series, 'chapter-1', 'panel-1', (panel) => markSubmitted(panel, 'job-1'))
    series = updatePanel(series, 'chapter-1', 'panel-2', (panel) => markSubmitted(panel, 'job-gone'))
    const jobs = [{ id: 'job-1', state: 'succeeded' as const, outputs: [output] }]
    const partial = reconcile(series, jobs)
    expect(panelsOf(partial).map((panel) => panel.state)).toEqual(['review', 'running', 'draft'])
    expect(panelsOf(reconcile(series, jobs, true))[1]).toMatchObject({ state: 'queued', error: '找不到这次生成的记录' })
    expect(reconcile(partial, jobs)).toBe(partial)
  })
})
