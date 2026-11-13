import { z } from 'zod'
import { defaultBalloonPlaces } from './balloons'
import { MAX_PANELS_PER_PAGE, PAGE_LAYOUTS, layoutById, layoutForCount } from './layouts'
import { extractJson, storyMemory, type MemoryRequest } from './memory'
import {
  BALLOON_KINDS,
  MAX_CAST,
  MAX_DIALOGUE,
  SHOTS,
  emptyPanel,
  mangaPageSchema,
  type MangaChapter,
  type MangaPage,
  type MangaPanel,
  type MangaSeries,
  type Shot,
} from './model'

/**
 * 分镜: the language model turns a chapter outline into pages of panels. It
 * answers one JSON object; the answer is checked and mapped onto the series
 * (character names to ids, outfits by name, a template for each page). What
 * cannot be mapped is kept where it can be and reported as a warning instead
 * of failing the whole storyboard.
 */

export interface StoryboardOptions {
  /** Roughly how many pages the chapter should be. */
  pages: number
}

function characterSheet(series: Pick<MangaSeries, 'characters'>): string {
  if (!series.characters.length) return '（还没有人物卡，可以只写群众或环境）'
  return series.characters
    .map((character) => {
      const outfits = character.outfits.map((outfit) => outfit.name).filter(Boolean)
      return [
        `- ${character.name}${character.role ? `（${character.role}）` : ''}`,
        character.personality ? `  性格：${character.personality}` : '',
        character.appearance ? `  外貌：${character.appearance}` : '',
        outfits.length ? `  服装：${outfits.join('、')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')
}

export function storyboardRequest(
  series: Pick<MangaSeries, 'title' | 'logline' | 'characters' | 'chapters' | 'facts' | 'readingDirection'>,
  chapter: MangaChapter,
  options: StoryboardOptions,
): MemoryRequest {
  const layouts = PAGE_LAYOUTS.map((layout) => `${layout.id}（${layout.rects.length} 格，${layout.label}）`).join('、')
  const memory = storyMemory(series, chapter.id)
  return {
    system: [
      '你是漫画分镜师。把一话的剧情拆成页和格，每格是一张要画的图。',
      '只输出一个 JSON 对象，不要输出其他文字，格式：',
      '{"pages": [{"layout": "版式 id", "panels": [{"scene": "画面描述", "shot": "镜头", "cast": [{"name": "人物名", "outfit": "服装名", "expression": "表情", "pose": "动作"}], "dialogue": [{"speaker": "人物名", "kind": "类型", "text": "台词"}]}]}]}',
      `版式 id 只能是：${layouts}。每页的格数要和版式一致。`,
      `镜头 shot 只能是：${SHOTS.join('、')}（远景、全景、中景、近景、特写）。`,
      `对白类型 kind 只能是：${BALLOON_KINDS.join('、')}（对白、心声、喊叫、旁白）；旁白不写 speaker。`,
      'scene 写看得见的东西：地点、光线、人物位置和动作、构图，不写台词，不写人物外貌（外貌由人物卡提供）。',
      'cast 只能用人物卡里的名字，outfit 只能用该人物已有的服装名，没有就不写。',
      '每格对白不超过 3 句，每句不超过 30 字。节奏要有快有慢，关键时刻用大格和特写。',
      `阅读方向：${series.readingDirection === 'rtl' ? '从右到左' : '从左到右'}。`,
    ].join('\n'),
    user: [
      `作品：${series.title}`,
      series.logline ? `简介：${series.logline}` : '',
      `人物卡：\n${characterSheet(series)}`,
      memory,
      `第 ${chapter.number} 话${chapter.title ? `「${chapter.title}」` : ''}，大约 ${options.pages} 页。大纲：\n${chapter.outline}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  }
}

const loose = z.string().max(4000).catch('')
const answerSchema = z.object({
  pages: z
    .array(
      z.object({
        layout: loose,
        panels: z
          .array(
            z.object({
              scene: loose,
              shot: loose,
              cast: z
                .array(z.object({ name: loose, outfit: loose.optional(), expression: loose.optional(), pose: loose.optional() }))
                .catch([]),
              dialogue: z.array(z.object({ speaker: loose.optional(), kind: loose.optional(), text: loose })).catch([]),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
})

export interface ParsedStoryboard {
  pages: MangaPage[]
  /** What was changed or dropped while mapping, in plain words. */
  warnings: string[]
}

const normalizeName = (name: string): string => name.replace(/\s+/g, '').toLowerCase()

/** The document's limits (model.ts), so a storyboard that parses can always be saved. */
const LIMITS = { scene: 4000, expression: 200, pose: 200, text: 1000, pages: 200 } as const

export function parseStoryboard(
  text: string,
  series: Pick<MangaSeries, 'characters' | 'readingDirection'>,
  makeId: (prefix: string) => string,
): ParsedStoryboard {
  const parsed = answerSchema.safeParse(extractJson(text))
  if (!parsed.success) throw new Error('语言模型返回的分镜格式不对，请再试一次')
  const warnings = new Set<string>()
  const byName = new Map(series.characters.map((character) => [normalizeName(character.name), character]))

  const clip = (text: string, max: number): string => {
    const value = text.trim()
    if (value.length <= max) return value
    warnings.add('有的描述或台词太长，已截断')
    return value.slice(0, max)
  }
  const pages: MangaPage[] = []
  for (const rawPage of parsed.data.pages) {
    // A page with more panels than any template is split across pages.
    for (let start = 0; start < rawPage.panels.length; start += MAX_PANELS_PER_PAGE) {
      const rawPanels = rawPage.panels.slice(start, start + MAX_PANELS_PER_PAGE)
      if (start > 0) warnings.add('有一页的格子太多，已拆成两页')
      const asked = layoutById(rawPage.layout)
      const layout = asked && asked.rects.length === rawPanels.length ? asked : layoutForCount(rawPanels.length)
      if (rawPage.layout && asked && asked.rects.length !== rawPanels.length) warnings.add('有的页格数和版式不一致，已换成合适的版式')

      const panels = rawPanels.map((raw): MangaPanel => {
        const panel = emptyPanel(makeId('panel'))
        panel.scene = clip(raw.scene, LIMITS.scene)
        panel.shot = (SHOTS as readonly string[]).includes(raw.shot) ? (raw.shot as Shot) : 'medium'
        for (const member of raw.cast) {
          const character = byName.get(normalizeName(member.name))
          if (!character) {
            if (member.name.trim()) warnings.add(`「${member.name.trim()}」不在人物卡里，已从格子里去掉`)
            continue
          }
          if (panel.cast.some((item) => item.characterId === character.id)) continue
          if (panel.cast.length >= MAX_CAST) {
            warnings.add(`一格最多 ${MAX_CAST} 个人物，多出的已去掉`)
            break
          }
          const outfit = member.outfit?.trim() ? character.outfits.find((item) => item.name === member.outfit!.trim()) : undefined
          if (member.outfit?.trim() && !outfit) warnings.add(`${character.name}没有「${member.outfit.trim()}」这套服装，用了默认服装`)
          panel.cast.push({
            characterId: character.id,
            ...(outfit ? { outfitId: outfit.id } : {}),
            expression: clip(member.expression ?? '', LIMITS.expression),
            pose: clip(member.pose ?? '', LIMITS.pose),
          })
        }
        const spoken = raw.dialogue.filter((line) => line.text.trim())
        if (spoken.length > MAX_DIALOGUE) warnings.add(`一格最多 ${MAX_DIALOGUE} 句对白，多出的已去掉`)
        const lines = spoken.slice(0, MAX_DIALOGUE)
        const places = defaultBalloonPlaces(lines.length, series.readingDirection)
        panel.dialogue = lines.map((line, index) => {
          const kind = (BALLOON_KINDS as readonly string[]).includes(line.kind ?? '')
            ? (line.kind as MangaPanel['dialogue'][number]['kind'])
            : 'speech'
          const speaker = line.speaker?.trim() ? byName.get(normalizeName(line.speaker)) : undefined
          return {
            id: makeId('line'),
            kind,
            ...(speaker && kind !== 'narration' ? { speakerId: speaker.id } : {}),
            text: clip(line.text, LIMITS.text),
            ...places[index]!,
          }
        })
        if (!panel.scene) warnings.add('有的格子没有画面描述，请补上')
        return panel
      })
      while (panels.length < layout.rects.length) panels.push(emptyPanel(makeId('panel')))
      pages.push({ id: makeId('page'), layoutId: layout.id, panels })
    }
  }
  if (pages.length > LIMITS.pages) {
    warnings.add(`一话最多 ${LIMITS.pages} 页，多出的已去掉`)
    pages.length = LIMITS.pages
  }
  // Whatever slipped past the limits above would make every later save fail: refuse it here instead.
  for (const page of pages) {
    if (!mangaPageSchema.safeParse(page).success) throw new Error('语言模型返回的分镜有无法保存的内容，请再试一次')
  }
  return { pages, warnings: [...warnings] }
}
