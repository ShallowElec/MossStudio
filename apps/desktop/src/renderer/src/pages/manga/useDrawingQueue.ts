import { useEffect, useRef, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { BackendInfo } from '@shared/backend'
import type { MangaSeries } from '@shared/manga/model'
import { applyJob, markSubmitFailed, markSubmitted, nextRetryAt, nextToSubmit, reconcile, updatePanel } from '@shared/manga/queue'
import type { EngineFeatures } from '@shared/types'
import { call } from '../../lib/api'
import { electronStudioClient } from '../../lib/studioClient'
import { useApp } from '../../store'
import { readPreferredBundle } from './preferences'
import { panelRequest, postPanelJob } from './submit'
import type { SeriesUpdate } from './useSeries'

const RETRY_DELAY = 3000

/**
 * Runs the drawing queue of the open series while the 漫画 page is mounted:
 * every job update is folded into its panel, and queued panels are sent to
 * the engine as running ones finish. The queue is the panels' own state, so a
 * restart picks up where it stopped.
 */
export function useDrawingQueue(options: {
  series: MangaSeries | null
  current: () => MangaSeries | null
  update: SeriesUpdate
  notify: (message: string, tone: 'info' | 'error') => void
}): void {
  const jobs = useApp((state) => state.jobs)
  const catalog = useApp((state) => state.catalog)
  const sending = useRef(false)
  // Bumped when a round ends, so panels queued meanwhile are sent without waiting for another edit.
  const [round, setRound] = useState(0)
  const backend = useRef<BackendInfo | null>(null)
  const latest = useRef(options)
  latest.current = options

  // Job events: finished pictures go up for review, failures go back in the queue.
  useEffect(() => {
    latest.current.update((series) => reconcile(series, jobs))
  }, [jobs, options.series?.id])

  const { series } = options
  useEffect(() => {
    // Until the model library has loaded every panel would fail with 还没有可用的模型; it reruns when it arrives.
    if (!series || !catalog || sending.current) return
    const pending = series.chapters.flatMap((chapter) => nextToSubmit(chapter).map((panel) => ({ chapter, panel })))
    if (!pending.length) {
      // A retry that is still waiting wakes the queue when it is due.
      const due = nextRetryAt(series)
      if (due === null) return
      const timer = window.setTimeout(() => setRound((value) => value + 1), Math.max(0, due - Date.now()) + 50)
      return () => window.clearTimeout(timer)
    }
    sending.current = true
    let failures = 0
    const notes = new Set<string>()
    void (async () => {
      try {
        const features = await call<EngineFeatures | null>(Ipc.engineFeatures, {}).catch(() => null)
        if (!backend.current?.ready) backend.current = await electronStudioClient.backendInfo().catch(() => null)
        for (const { chapter, panel } of pending) {
          const now = latest.current.current()
          const liveChapter = now?.chapters.find((item) => item.id === chapter.id)
          const page = liveChapter?.pages.find((item) => item.panels.some((candidate) => candidate.id === panel.id))
          const live = page?.panels.find((item) => item.id === panel.id)
          // Stopped or edited away while the engine was asked.
          if (!now || !liveChapter || !page || live?.state !== 'queued') continue
          const request = panelRequest({
            series: now,
            chapter: liveChapter,
            page,
            panel: live,
            catalog,
            preferredBundleId: readPreferredBundle(),
            features,
          })
          if (!request.ok) {
            latest.current.update((value) =>
              updatePanel(value, chapter.id, panel.id, (item) => markSubmitFailed(item, request.message, request.retry)),
            )
            latest.current.notify(request.message, 'error')
            failures += 1
            continue
          }
          for (const note of request.notes) notes.add(note)
          try {
            const job = await postPanelJob(backend.current, request.body)
            // The job may have moved on before the answer arrived; its latest record applies at once.
            const seen = useApp.getState().jobs.find((item) => item.id === job.id) ?? job
            latest.current.update((value) =>
              updatePanel(value, chapter.id, panel.id, (item) => applyJob(markSubmitted(item, job.id), seen)),
            )
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            backend.current = null
            failures += 1
            latest.current.update((value) => updatePanel(value, chapter.id, panel.id, (item) => markSubmitFailed(item, message)))
          }
        }
      } finally {
        for (const note of notes) latest.current.notify(note, 'info')
        sending.current = false
        // A failed send waits a little before its retry, so a backend that is still starting gets the time.
        window.setTimeout(() => setRound((value) => value + 1), failures ? RETRY_DELAY : 0)
      }
    })()
  }, [series, catalog, round])
}
