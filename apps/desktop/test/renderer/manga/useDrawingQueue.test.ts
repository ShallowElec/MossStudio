import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { MangaSeries } from '@shared/manga/model'
import { chapterPanels, markSubmitted, updatePanel } from '@shared/manga/queue'
import { useDrawingQueue } from '@renderer/pages/manga/useDrawingQueue'
import type { SeriesUpdate } from '@renderer/pages/manga/useSeries'
import { useApp } from '@renderer/store'
import { mangaSeriesFixture } from '../../mocks/backend/manga'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  useApp.setState({ jobs: [], ready: false, catalog: null })
})

/** Mounts the queue on a series held in memory; the model library stays unloaded, so nothing is sent. */
function mount(initial: MangaSeries): { series: () => MangaSeries; edit: (change: (value: MangaSeries) => MangaSeries) => void } {
  let series = initial
  const update: SeriesUpdate = (change) => {
    series = typeof change === 'function' ? change(series) : change
  }
  function Host(): null {
    useDrawingQueue({ series, current: () => series, update, notify: () => undefined })
    return null
  }
  root = createRoot(document.createElement('div'))
  act(() => root!.render(createElement(Host)))
  return {
    series: () => series,
    edit: (change) => {
      update(change)
      act(() => root!.render(createElement(Host)))
    },
  }
}

const states = (series: MangaSeries): string[] => chapterPanels(series.chapters[0]!).map((panel) => panel.state)

describe('useDrawingQueue', () => {
  it('retries a running panel whose job fell out of the job list, once the list has loaded', () => {
    useApp.setState({ jobs: [], ready: false, catalog: null })
    const host = mount(updatePanel(mangaSeriesFixture(), 'chapter-1', 'panel-1', (panel) => markSubmitted(panel, 'job-expired')))
    expect(states(host.series())[0]).toBe('running')

    act(() => useApp.setState({ ready: true }))
    expect(chapterPanels(host.series().chapters[0]!)[0]).toMatchObject({ state: 'queued', error: '找不到这次生成的记录' })
  })

  it('leaves a panel sent after opening running until its job arrives', () => {
    useApp.setState({ jobs: [], ready: true, catalog: null })
    const host = mount(mangaSeriesFixture())
    // The panel is marked running before the job's first event reaches the store.
    host.edit((series) => updatePanel(series, 'chapter-1', 'panel-1', (panel) => markSubmitted(panel, 'job-new')))
    act(() => useApp.setState({ jobs: [] }))
    expect(states(host.series())[0]).toBe('running')
  })
})
