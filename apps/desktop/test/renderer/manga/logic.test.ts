import { describe, expect, it } from 'vitest'
import {
  applyTemplate,
  approveAll,
  exportBlockers,
  mergeBlocker,
  mergePanel,
  panelErrorText,
  newPage,
  newSeries,
  nextChapterNumber,
  panelsInUse,
  firstUsable,
  splitBlocker,
  splitPanel,
} from '@renderer/pages/manga/logic'
import { dragGutter, frameHandles, leafCount } from '@shared/manga/layouts'
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

  it('applies a template without dropping panels that have content, blank ones going from the end first', () => {
    const page = newPage('grid-four')
    expect(page.panels).toHaveLength(4)
    const filled = { ...page, panels: page.panels.map((panel, index) => (index === 1 ? { ...panel, scene: '有内容' } : panel)) }
    expect(panelsInUse(filled)).toBe(1)
    const two = applyTemplate(filled, 'two-rows')!
    expect(two.panels.map((panel) => panel.scene)).toEqual(['', '有内容'])
    expect(leafCount(two.frames)).toBe(2)
    expect(applyTemplate(filled, 'single')!.panels.map((panel) => panel.scene)).toEqual(['有内容'])
    const full = { ...filled, panels: filled.panels.map((panel) => ({ ...panel, scene: '有内容' })) }
    expect(applyTemplate(full, 'two-rows')).toBeUndefined()
    expect(applyTemplate(filled, 'six-grid')!.panels).toHaveLength(6)
    expect(applyTemplate(filled, 'nope')).toBeUndefined()
  })

  it('cuts a panel in two with the new one right after it, and merges back keeping the one with content', () => {
    const page = newPage('two-rows')
    const named = { ...page, panels: page.panels.map((panel, index) => ({ ...panel, scene: `格${index + 1}` })) }
    const cut = splitPanel(named, 0, 'x')!
    expect(cut.panels.map((panel) => panel.scene)).toEqual(['格1', '', '格2'])
    expect(leafCount(cut.frames)).toBe(3)
    expect(mergeBlocker(cut, 2)).toBe('旁边没有和它一刀切开的格')
    expect(mergeBlocker(named, 0)).toBe('两格都有内容，先清空其中一格')
    expect(mergeBlocker(cut, 1)).toBeUndefined()
    const merged = mergePanel(cut, 1)!
    expect(merged.panels.map((panel) => panel.scene)).toEqual(['格1', '格2'])
    expect(merged.frames).toEqual(named.frames)
    // A drawn panel is content too, even without a description.
    const drawn = { ...cut, panels: cut.panels.map((panel, index) => (index === 1 ? { ...panel, state: 'review' as const } : panel)) }
    expect(mergePanel(drawn, 1)).toBeUndefined()
  })

  it('says why a panel cannot be cut instead of offering a cut that does nothing', () => {
    const page = newPage('wide-then-two')
    expect(splitBlocker(page, 1, 'x')).toBeUndefined()
    // Squeeze the second panel of the lower row to the narrowest a panel may be.
    const down = frameHandles(page.frames, 'rtl').find((handle) => handle.axis === 'x')!
    const squeezed = { ...page, frames: dragGutter(page.frames, down.path, { x: 0, y: 1500 }, 'rtl')! }
    expect(splitBlocker(squeezed, 2, 'x')).toBe('这一格太窄，拆不开了')
    expect(splitPanel(squeezed, 2, 'x')).toBeUndefined()
    expect(splitBlocker(squeezed, 2, 'y')).toBeUndefined()
    let full = newPage('six-grid')
    while (full.panels.length < 12)
      full = splitPanel(full, full.panels.length - 1, full.panels.length % 2 ? 'y' : 'x') ?? splitPanel(full, 0, 'y')!
    expect(splitBlocker(full, 0, 'y')).toBe('一页最多 12 格')
  })

  it('picks the first drawn layout that has room for the panels with content', () => {
    expect(firstUsable([{ panels: 1 }, { panels: 2 }, { panels: 3 }, { panels: 4 }], 3)).toBe(2)
    expect(firstUsable([{ panels: 1 }, { panels: 2 }], 3)).toBeNull()
    expect(firstUsable([{ panels: 1 }], 0)).toBe(0)
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

  it('explains a panel that did not draw, without counting a request that was never sent', () => {
    const now = Date.parse('2026-11-12T10:00:00.000Z')
    expect(panelErrorText({ state: 'failed', attempts: 0, error: '还没有可用的模型，请先到模型页下载' }, now)).toBe(
      '还没有可用的模型，请先到模型页下载',
    )
    expect(panelErrorText({ state: 'failed', attempts: 3, error: '显存不够' }, now)).toBe('试了 3 次都没成功：显存不够')
    expect(panelErrorText({ state: 'queued', attempts: 1, error: '显存不够', retryAt: '2026-11-12T10:00:14.200Z' }, now)).toBe(
      '上次没成功，15 秒后重试：显存不够',
    )
    expect(panelErrorText({ state: 'running', attempts: 1, error: '显存不够' }, now)).toBe('上次没成功，正在重试：显存不够')
  })

  it('starts new series in strict black and white', () => {
    expect(newSeries().style.monochrome).toBe(true)
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
