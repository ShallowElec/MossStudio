import { applyFrames } from '@shared/manga/gacha'
import { MAX_FRAME_PANELS, leafCount, mergeFrame, mergeableWith, splitFrame, templateById, type FrameAxis } from '@shared/manga/layouts'
import {
  emptyPanel,
  isBlankPanel,
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

export function newPage(templateId = 'wide-then-two'): MangaPage {
  const frames = (templateById(templateId) ?? templateById('single')!).frames
  return { id: newId('page'), frames, panels: Array.from({ length: leafCount(frames) }, () => emptyPanel(newId('panel'))) }
}

/** Panels of `page` with anything in them: a new layout must have room for at least these. */
export function panelsInUse(page: MangaPage): number {
  return page.panels.filter((panel) => !isBlankPanel(panel)).length
}

/** A template's frames: panels keep their reading order, blank ones are added or dropped; undefined when it has no room. */
export function applyTemplate(page: MangaPage, templateId: string): MangaPage | undefined {
  const template = templateById(templateId)
  return template ? applyFrames(page, template.frames, newId) : undefined
}

/** 拆开: panel `index` cut in two, the new blank panel right after it. */
export function splitPanel(page: MangaPage, index: number, axis: FrameAxis): MangaPage | undefined {
  const frames = splitFrame(page.frames, index, axis)
  if (!frames) return undefined
  const panels = [...page.panels]
  panels.splice(index + 1, 0, emptyPanel(newId('panel')))
  return { ...page, frames, panels }
}

/** Why panel `index` cannot be cut along `axis`, or undefined when it can. */
export function splitBlocker(page: MangaPage, index: number, axis: FrameAxis): string | undefined {
  if (page.panels.length >= MAX_FRAME_PANELS) return `一页最多 ${MAX_FRAME_PANELS} 格`
  if (!splitFrame(page.frames, index, axis)) return axis === 'x' ? '这一格太窄，拆不开了' : '这一格太矮，拆不开了'
  return undefined
}

/** The first drawn layout with room for the page's panels that have content; null when none has. */
export function firstUsable(found: ReadonlyArray<{ panels: number }>, inUse: number): number | null {
  const index = found.findIndex((item) => item.panels >= inUse)
  return index < 0 ? null : index
}

/** Why panel `index` cannot be merged with its neighbour, or undefined when it can. */
export function mergeBlocker(page: MangaPage, index: number): string | undefined {
  const other = mergeableWith(page.frames, index)
  if (other === undefined) return '旁边没有和它一刀切开的格'
  if (!isBlankPanel(page.panels[index]!) && !isBlankPanel(page.panels[other]!)) return '两格都有内容，先清空其中一格'
  return undefined
}

/** 合并: panel `index` and its neighbour become one, keeping whichever has content. */
export function mergePanel(page: MangaPage, index: number): MangaPage | undefined {
  const other = mergeableWith(page.frames, index)
  const frames = mergeFrame(page.frames, index)
  if (other === undefined || !frames || mergeBlocker(page, index)) return undefined
  const keep = isBlankPanel(page.panels[index]!) ? page.panels[other]! : page.panels[index]!
  const first = Math.min(index, other)
  const panels = page.panels.filter((_, at) => at !== index && at !== other)
  panels.splice(first, 0, keep)
  return { ...page, frames, panels }
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
