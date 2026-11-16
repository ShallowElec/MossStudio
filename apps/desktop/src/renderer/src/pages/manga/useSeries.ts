import { useCallback, useEffect, useRef, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { MangaSeries, MangaSeriesSave, MangaSeriesSummary } from '@shared/manga/model'
import { call } from '../../lib/api'

export function useSeriesList(): {
  items: MangaSeriesSummary[]
  loaded: boolean
  error: string | null
  reload: () => void
} {
  const [items, setItems] = useState<MangaSeriesSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    call<MangaSeriesSummary[]>(Ipc.mangaList)
      .then((list) => {
        setItems(list)
        setError(null)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoaded(true))
  }, [])
  useEffect(reload, [reload])
  return { items, loaded, error, reload }
}

/**
 * What is sent to main. Fields that are briefly empty while someone types
 * (a cleared name, a blank fact) would fail validation, so they are saved
 * with a fallback or left out; the screen keeps showing what was typed.
 */
export function toSave(series: MangaSeries): MangaSeriesSave {
  const { schemaVersion: _version, createdAt: _created, updatedAt: _updated, ...rest } = series
  return {
    ...rest,
    title: rest.title.trim() || '未命名漫画',
    characters: rest.characters.map((character) => ({ ...character, name: character.name.trim() || '未命名人物' })),
    facts: rest.facts.filter((fact) => fact.text.trim()),
  }
}

const SAVE_DELAY = 600

export type SeriesUpdate = (change: MangaSeries | ((current: MangaSeries) => MangaSeries)) => void

/**
 * One open series. Edits apply at once and are saved shortly after the last
 * one; the local copy stays the source of truth, so a save that returns while
 * someone keeps typing never puts older text back.
 */
export function useSeriesDocument(id: string | null): {
  series: MangaSeries | null
  loading: boolean
  error: string | null
  saveError: string | null
  update: SeriesUpdate
  /** The latest edits, read at call time (for the drawing queue). */
  current: () => MangaSeries | null
  saveNow: () => Promise<boolean>
} {
  const [series, setSeries] = useState<MangaSeries | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const latest = useRef<MangaSeries | null>(null)
  const timer = useRef<number | null>(null)
  const dirty = useRef(false)

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    const value = latest.current
    if (!value || !dirty.current) return true
    dirty.current = false
    try {
      await call<MangaSeries>(Ipc.mangaSave, toSave(value))
      setSaveError(null)
      return true
    } catch (reason) {
      dirty.current = true
      setSaveError(reason instanceof Error ? reason.message : String(reason))
      return false
    }
  }, [])

  useEffect(() => {
    latest.current = null
    setSeries(null)
    setError(null)
    if (!id) return
    let alive = true
    setLoading(true)
    call<MangaSeries | null>(Ipc.mangaGet, { id })
      .then((value) => {
        if (!alive) return
        if (!value) setError('这部漫画打不开了，可能已经删除')
        latest.current = value
        setSeries(value)
      })
      .catch((reason: unknown) => alive && setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
      void flush()
    }
  }, [id, flush])

  const update = useCallback<SeriesUpdate>(
    (change) => {
      const base = latest.current
      if (!base) return
      const next = typeof change === 'function' ? change(base) : change
      if (next === base) return
      latest.current = next
      dirty.current = true
      setSeries(next)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY)
    },
    [flush],
  )

  const current = useCallback(() => latest.current, [])
  return { series, loading, error, saveError, update, current, saveNow: flush }
}
