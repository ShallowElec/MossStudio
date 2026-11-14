import type { JobRecord } from '../types'
import type { MangaChapter, MangaPanel, MangaSeries, PanelState } from './model'

/**
 * Drawing a chapter: which panels go to the engine next, what a job's end does
 * to its panel, and the review step. A failed run is retried with a new seed
 * up to MAX_ATTEMPTS times before the panel is marked failed; a finished
 * picture always waits for a person (审核) before it counts as done. Pure: the
 * renderer feeds jobs in and saves the series that comes out.
 */

export const MAX_ATTEMPTS = 3
/** Panels sent to the engine at once; the engine queues them anyway, this keeps retries close. */
export const MAX_ACTIVE = 2
/** Wait before retry N is this times N (15 s, then 30 s): a run that ran out of graphics memory rarely succeeds at once. */
export const RETRY_BACKOFF_MS = 15_000

export interface PanelAddress {
  chapterId: string
  pageId: string
  panelId: string
}

export function mapPanels(
  series: MangaSeries,
  chapterId: string,
  change: (panel: MangaPanel, address: PanelAddress) => MangaPanel,
): MangaSeries {
  return {
    ...series,
    chapters: series.chapters.map((chapter) =>
      chapter.id !== chapterId
        ? chapter
        : {
            ...chapter,
            pages: chapter.pages.map((page) => ({
              ...page,
              panels: page.panels.map((panel) => change(panel, { chapterId, pageId: page.id, panelId: panel.id })),
            })),
          },
    ),
  }
}

export function updatePanel(
  series: MangaSeries,
  chapterId: string,
  panelId: string,
  change: (panel: MangaPanel) => MangaPanel,
): MangaSeries {
  return mapPanels(series, chapterId, (panel) => (panel.id === panelId ? change(panel) : panel))
}

export function chapterPanels(chapter: Pick<MangaChapter, 'pages'>): MangaPanel[] {
  return chapter.pages.flatMap((page) => page.panels)
}

/** Panels that still need a picture: never drawn, or failed. */
const NEEDS_DRAWING: ReadonlySet<PanelState> = new Set(['draft', 'failed'])

/**
 * Put panels in the queue. Without ids: every panel of the chapter that still
 * needs a picture. With ids: exactly those (drawing an approved panel again
 * keeps its old takes). Empty panels (no scene) are left alone.
 */
export function enqueue(series: MangaSeries, chapterId: string, panelIds?: readonly string[]): MangaSeries {
  const chosen = panelIds ? new Set(panelIds) : null
  return mapPanels(series, chapterId, (panel) => {
    const wanted = chosen ? chosen.has(panel.id) : NEEDS_DRAWING.has(panel.state)
    if (!wanted || panel.state === 'running' || !(panel.scene.trim() || panel.promptOverride?.trim())) return panel
    return { ...panel, state: 'queued', attempts: 0, error: undefined, retryAt: undefined }
  })
}

/** Take queued panels out of the queue (停止); a running job is not touched here. */
export function dequeue(series: MangaSeries, chapterId: string): MangaSeries {
  return mapPanels(series, chapterId, (panel) =>
    panel.state === 'queued' ? { ...panel, state: panel.takes.length ? 'review' : 'draft', retryAt: undefined } : panel,
  )
}

const waiting = (panel: MangaPanel, now: number): boolean => Boolean(panel.retryAt && Date.parse(panel.retryAt) > now)

/**
 * The panels to send now, in reading order (chapter by chapter), keeping at most MAX_ACTIVE running across the
 * whole series; a retry waits for its time.
 */
export function nextToSubmit(
  series: Pick<MangaSeries, 'chapters'>,
  limit = MAX_ACTIVE,
  now = Date.now(),
): Array<{ chapter: MangaChapter; panel: MangaPanel }> {
  const all = series.chapters.flatMap((chapter) => chapterPanels(chapter).map((panel) => ({ chapter, panel })))
  const running = all.filter(({ panel }) => panel.state === 'running').length
  return all.filter(({ panel }) => panel.state === 'queued' && !waiting(panel, now)).slice(0, Math.max(0, limit - running))
}

/** When the next waiting retry of `series` is due (ms since epoch), or null when none waits. */
export function nextRetryAt(series: Pick<MangaSeries, 'chapters'>, now = Date.now()): number | null {
  const due = series.chapters
    .flatMap((chapter) => chapterPanels(chapter))
    .filter((panel) => panel.state === 'queued' && waiting(panel, now))
    .map((panel) => Date.parse(panel.retryAt!))
  return due.length ? Math.min(...due) : null
}

/** The last failure stays shown while its retry runs; a success clears it. */
export function markSubmitted(panel: MangaPanel, jobId: string): MangaPanel {
  return { ...panel, state: 'running', jobId }
}

function failed(panel: MangaPanel, message: string, now: number): MangaPanel {
  const attempts = panel.attempts + 1
  const rest = { ...panel, jobId: undefined, attempts, error: message }
  // Retrying keeps the panel in the queue; the next submit draws a new seed.
  if (attempts < MAX_ATTEMPTS) return { ...rest, state: 'queued', retryAt: new Date(now + RETRY_BACKOFF_MS * attempts).toISOString() }
  return { ...rest, state: 'failed', retryAt: undefined }
}

/** Sending the job failed before the engine took it (no model, engine down…). */
export function markSubmitFailed(panel: MangaPanel, message: string, retry = true, now = Date.now()): MangaPanel {
  if (!retry) return { ...panel, jobId: undefined, state: 'failed', error: message, retryAt: undefined }
  return failed(panel, message, now)
}

/** What a job's latest record means for its panel; other jobs leave it unchanged. */
export function applyJob(panel: MangaPanel, job: Pick<JobRecord, 'id' | 'state' | 'outputs' | 'error'>, now = Date.now()): MangaPanel {
  if (!panel.jobId || panel.jobId !== job.id) return panel
  if (job.state === 'succeeded') {
    const takes = (job.outputs ?? []).map((output) => ({ ...output, jobId: job.id }))
    if (!takes.length) return failed(panel, '生成完成了，但没有拿到图片', now)
    return {
      ...panel,
      state: 'review',
      jobId: undefined,
      attempts: 0,
      error: undefined,
      retryAt: undefined,
      // A redraw of an approved panel is reviewed afresh: the old choice no longer stands, so the new picture shows
      // and 通过 approves what is shown.
      chosen: undefined,
      takes: [...panel.takes, ...takes].slice(-30),
    }
  }
  if (job.state === 'failed') return failed(panel, job.error?.message ?? '生成失败了', now)
  // Stopped by a person: not retried.
  if (job.state === 'canceled') return { ...panel, jobId: undefined, state: panel.takes.length ? 'review' : 'draft' }
  return panel.state === 'running' ? panel : { ...panel, state: 'running' }
}

export function approve(panel: MangaPanel, take: number): MangaPanel {
  if (!panel.takes[take]) return panel
  return { ...panel, state: 'approved', chosen: take, note: undefined }
}

/** 重画: back into the queue, with what the reviewer wants changed. */
export function reject(panel: MangaPanel, note: string): MangaPanel {
  const trimmed = note.trim()
  return {
    ...panel,
    state: 'queued',
    attempts: 0,
    error: undefined,
    retryAt: undefined,
    ...(trimmed ? { note: trimmed } : { note: undefined }),
  }
}

export type ChapterProgress = Record<PanelState, number> & { total: number }

export function chapterProgress(chapter: Pick<MangaChapter, 'pages'>): ChapterProgress {
  const counts: ChapterProgress = { draft: 0, queued: 0, running: 0, review: 0, approved: 0, failed: 0, total: 0 }
  for (const panel of chapterPanels(chapter)) {
    counts[panel.state] += 1
    counts.total += 1
  }
  return counts
}

/**
 * Panels whose job record says it is over, while the panel still waits: after a
 * restart, or an event missed. With `complete` (the full job list was read), a
 * running panel whose job is not in it at all is treated as a failed run.
 */
export function reconcile(
  series: MangaSeries,
  jobs: readonly Pick<JobRecord, 'id' | 'state' | 'outputs' | 'error'>[],
  complete = false,
  now = Date.now(),
): MangaSeries {
  const byId = new Map(jobs.map((job) => [job.id, job]))
  let changed = false
  const next = {
    ...series,
    chapters: series.chapters.map((chapter) => {
      let touched = false
      const pages = chapter.pages.map((page) => ({
        ...page,
        panels: page.panels.map((panel) => {
          const job = panel.jobId ? byId.get(panel.jobId) : undefined
          if (!job && !(complete && panel.state === 'running')) return panel
          const updated = job ? applyJob(panel, job, now) : failed(panel, '找不到这次生成的记录', now)
          if (updated !== panel && JSON.stringify(updated) !== JSON.stringify(panel)) {
            touched = true
            return updated
          }
          return panel
        }),
      }))
      if (!touched) return chapter
      changed = true
      return { ...chapter, pages }
    }),
  }
  return changed ? next : series
}
