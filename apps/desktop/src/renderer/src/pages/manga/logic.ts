import { PAGE_LAYOUTS, layoutById } from '@shared/manga/layouts'
import {
  emptyPanel,
  newId,
  type MangaChapter,
  type MangaPage,
  type MangaPanel,
  type MangaSeries,
  type MangaSeriesSave,
  type PanelState,
} from '@shared/manga/model'
import { approve, chapterPanels, mapPanels } from '@shared/manga/queue'
import { DEFAULT_QUALITY, qualityPreset } from '../studio/defaults'

/** Pure helpers behind the 漫画 page: wording of states and the edits its buttons make. */

export const PANEL_STATE_LABEL: Record<PanelState, string> = {
  draft: '未生成',
  queued: '排队中',
  running: '生成中',
  review: '待审核',
  approved: '已通过',
  failed: '失败',
}

export const PANEL_STATE_TONE: Record<PanelState, 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'> = {
  draft: 'neutral',
  queued: 'accent',
  running: 'accent',
  review: 'warn',
  approved: 'ok',
  failed: 'danger',
}

export function newChapter(number: number): MangaChapter {
  return { id: newId('chapter'), number, title: '', outline: '', summary: '', pages: [] }
}

export function newSeries(): MangaSeriesSave {
  const quality = qualityPreset(DEFAULT_QUALITY)
  return {
    title: '未命名漫画',
    logline: '',
    readingDirection: 'rtl',
    style: {
      prompt: '黑白日式漫画，纯黑白，网点，干净利落的线条',
      negative: '',
      adapters: [],
      monochrome: true,
      steps: quality.steps,
      cfg: quality.cfg,
    },
    characters: [],
    chapters: [newChapter(1)],
    facts: [],
  }
}

export function chapterLabel(chapter: Pick<MangaChapter, 'number' | 'title'>): string {
  return `第 ${chapter.number} 话${chapter.title.trim() ? ` ${chapter.title.trim()}` : ''}`
}

export function nextChapterNumber(series: Pick<MangaSeries, 'chapters'>): number {
  return Math.max(0, ...series.chapters.map((chapter) => chapter.number)) + 1
}

export function updateChapter(series: MangaSeries, chapterId: string, change: (chapter: MangaChapter) => MangaChapter): MangaSeries {
  return { ...series, chapters: series.chapters.map((chapter) => (chapter.id === chapterId ? change(chapter) : chapter)) }
}

export function updatePage(series: MangaSeries, chapterId: string, pageId: string, change: (page: MangaPage) => MangaPage): MangaSeries {
  return updateChapter(series, chapterId, (chapter) => ({
    ...chapter,
    pages: chapter.pages.map((page) => (page.id === pageId ? change(page) : page)),
  }))
}

export function newPage(layoutId = 'wide-then-two'): MangaPage {
  const layout = layoutById(layoutId) ?? PAGE_LAYOUTS[0]!
  return { id: newId('page'), layoutId: layout.id, panels: layout.rects.map(() => emptyPanel(newId('panel'))) }
}

const isBlank = (panel: MangaPage['panels'][number]): boolean =>
  !panel.scene.trim() && !panel.takes.length && !panel.dialogue.length && !panel.cast.length

/** Panels a page must keep when its template changes: up to the last one with anything in it. */
export function panelsInUse(page: MangaPage): number {
  for (let index = page.panels.length - 1; index >= 0; index -= 1) if (!isBlank(page.panels[index]!)) return index + 1
  return 0
}

/** A new template: empty panels are added or dropped at the end; panels with content are never dropped. */
export function changeLayout(page: MangaPage, layoutId: string): MangaPage {
  const layout = layoutById(layoutId)
  if (!layout || layout.rects.length < panelsInUse(page)) return page
  const panels = page.panels.slice(0, layout.rects.length)
  while (panels.length < layout.rects.length) panels.push(emptyPanel(newId('panel')))
  return { ...page, layoutId: layout.id, panels }
}

/** 全部通过: every panel waiting for review takes its newest picture. */
export function approveAll(series: MangaSeries, chapterId: string): MangaSeries {
  return mapPanels(series, chapterId, (panel) => (panel.state === 'review' ? approve(panel, panel.takes.length - 1) : panel))
}

/** Pages ready to export: every panel approved. */
export function exportBlockers(chapter: MangaChapter): string | null {
  if (!chapter.pages.length) return '这一话还没有页面'
  const panels = chapterPanels(chapter)
  const waiting = panels.filter((panel) => panel.state !== 'approved').length
  return waiting ? `还有 ${waiting} 格没有通过审核` : null
}

/**
 * The line under a panel that did not draw. A request that could not be sent
 * at all (no model) was never tried, so it says only why; a retry says it is
 * waiting when it is.
 */
export function panelErrorText(panel: Pick<MangaPanel, 'state' | 'attempts' | 'error' | 'retryAt'>, now = Date.now()): string {
  const reason = panel.error ?? ''
  if (panel.state === 'failed') return panel.attempts > 0 ? `试了 ${panel.attempts} 次都没成功：${reason}` : reason
  if (panel.retryAt && Date.parse(panel.retryAt) > now) {
    return `上次没成功，${Math.ceil((Date.parse(panel.retryAt) - now) / 1000)} 秒后重试：${reason}`
  }
  return `上次没成功，正在重试：${reason}`
}
