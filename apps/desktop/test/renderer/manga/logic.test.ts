import { describe, expect, it } from 'vitest'
import {
  approveAll,
  changeLayout,
  exportBlockers,
  nearestSpot,
  newPage,
  newSeries,
  nextChapterNumber,
  panelsInUse,
} from '@renderer/pages/manga/logic'
import { toSave } from '@renderer/pages/manga/useSeries'
import { mangaSeriesSaveSchema } from '@shared/manga/model'
import { chapterPanels, updatePanel } from '@shared/manga/queue'
import { mangaSeriesFixture } from '../../mocks/backend/manga'

describe('manga page logic', () => {
  it('starts a new series with one empty chapter that main accepts', () => {
    const series = newSeries()
    expect(series.chapters.map((chapter) => chapter.number)).toEqual([1])
    expect(mangaSeriesSaveSchema.safeParse(series).success).toBe(true)
    expect(nextChapterNumber(mangaSeriesFixture())).toBe(2)
  })

  it('changes a page template without dropping panels that have content', () => {
    const page = newPage('grid-four')
    expect(page.panels).toHaveLength(4)
    const filled = { ...page, panels: page.panels.map((panel, index) => (index === 1 ? { ...panel, scene: '有内容' } : panel)) }
    expect(panelsInUse(filled)).toBe(2)
    expect(changeLayout(filled, 'two-rows').panels.map((panel) => panel.scene)).toEqual(['', '有内容'])
    expect(changeLayout(filled, 'single')).toBe(filled)
    expect(changeLayout(filled, 'six-grid').panels).toHaveLength(6)
    expect(changeLayout(filled, 'nope')).toBe(filled)
  })

  it('approves every panel in review with its newest take, and exports only when all are approved', () => {
    const take = { path: '/out/a.png', width: 1, height: 1, seed: 1, jobId: 'j' }
    let series = mangaSeriesFixture()
    expect(exportBlockers(series.chapters[0]!)).toBe('还有 3 格没有通过审核')
    for (const id of ['panel-1', 'panel-2', 'panel-3']) {
      series = updatePanel(series, 'chapter-1', id, (panel) => ({ ...panel, state: 'review', takes: [take, { ...take, seed: 2 }] }))
    }
    series = approveAll(series, 'chapter-1')
    expect(chapterPanels(series.chapters[0]!).map((panel) => [panel.state, panel.chosen])).toEqual([
      ['approved', 1],
      ['approved', 1],
      ['approved', 1],
    ])
    expect(exportBlockers(series.chapters[0]!)).toBeNull()
    expect(exportBlockers({ ...series.chapters[0]!, pages: [] })).toBe('这一话还没有页面')
  })

  it('names the nearest balloon spot', () => {
    expect(nearestSpot(0.8, 0.16)).toBe('tr')
    expect(nearestSpot(0.45, 0.55)).toBe('mc')
  })

  it('saves with fallbacks for fields emptied while typing', () => {
    const series = mangaSeriesFixture({ title: ' ', facts: [{ id: 'f', text: '  ' }] })
    series.characters[0]!.name = ''
    const saved = toSave(series)
    expect(saved).toMatchObject({ title: '未命名漫画', facts: [] })
    expect(saved.characters[0]!.name).toBe('未命名人物')
    expect(mangaSeriesSaveSchema.safeParse(saved).success).toBe(true)
  })
})
