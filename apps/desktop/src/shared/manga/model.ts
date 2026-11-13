import { z } from 'zod'

/**
 * The 漫画 workflow's document: one series (作品) with its characters (人物卡),
 * chapters (章节), pages, panels (格) and story memory (剧情记忆). Main stores
 * it as JSON and validates it with these schemas; the renderer edits it. The
 * series' pictures (reference images) live in a backing Studio project's
 * assets folder, so the engine and clover:// accept them like any Studio input.
 */

export const MANGA_SCHEMA_VERSION = 1

const id = z.string().min(1).max(120)
const shortText = z.string().max(200)
const longText = z.string().max(20_000)

export const mangaAdapterSchema = z.object({ id: z.string().min(1).max(160), strength: z.number().min(0).max(2) })

export const mangaImageSchema = z.object({
  path: z.string().min(1).max(4096),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

export const mangaOutfitSchema = z.object({
  id,
  name: shortText,
  /** What the outfit looks like, added to the panel description when the character wears it. */
  prompt: z.string().max(2000),
})

export const mangaCharacterSchema = z.object({
  id,
  name: z.string().min(1).max(60),
  /** 主角, 配角… free text shown to the language model. */
  role: shortText,
  /** Face, hair, build: the part of the description that never changes. */
  appearance: z.string().max(4000),
  personality: z.string().max(4000),
  /** Words a character LoRA was trained on; added before the appearance. */
  triggerWords: z.string().max(500),
  references: z.array(mangaImageSchema).max(8),
  outfits: z.array(mangaOutfitSchema).max(20),
  defaultOutfitId: id.optional(),
  adapters: z.array(mangaAdapterSchema).max(8),
})

export const BALLOON_KINDS = ['speech', 'thought', 'shout', 'narration'] as const
export type BalloonKind = (typeof BALLOON_KINDS)[number]

export const mangaBalloonSchema = z.object({
  id,
  kind: z.enum(BALLOON_KINDS),
  /** A character id; absent for narration or an unknown voice. */
  speakerId: id.optional(),
  text: z.string().max(1000),
  /** Centre of the balloon inside its panel, 0–1. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
})

export const SHOTS = ['wide', 'full', 'medium', 'close', 'extreme'] as const
export type Shot = (typeof SHOTS)[number]

export const mangaCastSchema = z.object({
  characterId: id,
  outfitId: id.optional(),
  /** 表情 and 动作 for this panel only. */
  expression: z.string().max(200),
  pose: z.string().max(200),
})

export const mangaTakeSchema = z.object({
  path: z.string().min(1).max(4096),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  seed: z.number().int().min(0),
  jobId: z.string().max(200),
})

/**
 * Where a panel's drawing stands. `queued`: waiting for its turn; `running`:
 * a job is drawing it; `review`: a take waits for a person; `approved`:
 * a take is chosen; `failed`: it gave up after its retries.
 */
export const PANEL_STATES = ['draft', 'queued', 'running', 'review', 'approved', 'failed'] as const
export type PanelState = (typeof PANEL_STATES)[number]

export const mangaPanelSchema = z.object({
  id,
  /** What happens in the picture (画面描述). */
  scene: z.string().max(4000),
  shot: z.enum(SHOTS),
  cast: z.array(mangaCastSchema).max(6),
  dialogue: z.array(mangaBalloonSchema).max(12),
  /** Replaces the compiled description when set (精修). */
  promptOverride: z.string().max(8000).optional(),
  state: z.enum(PANEL_STATES),
  jobId: z.string().max(200).optional(),
  /** Failed runs since the last success or manual retry. */
  attempts: z.number().int().min(0),
  error: z.string().max(2000).optional(),
  takes: z.array(mangaTakeSchema).max(30),
  /** Index into `takes` of the approved picture. */
  chosen: z.number().int().min(0).optional(),
  /** What the reviewer asked for when sending it back (重画说明). */
  note: z.string().max(1000).optional(),
})

export const mangaPageSchema = z.object({
  id,
  layoutId: z.string().min(1).max(40),
  panels: z.array(mangaPanelSchema).max(12),
})

export const mangaChapterSchema = z.object({
  id,
  number: z.number().int().min(1).max(9999),
  title: shortText,
  /** The plot of this chapter as the author wrote it (剧情大纲). */
  outline: longText,
  /** What happened, written after the chapter is done (剧情记忆). */
  summary: z.string().max(4000),
  pages: z.array(mangaPageSchema).max(200),
})

export const mangaFactSchema = z.object({
  id,
  text: z.string().min(1).max(500),
  /** The chapter that established it; absent for facts the author added. */
  chapterId: id.optional(),
})

export const mangaStyleSchema = z.object({
  /** The look every panel shares (画风). */
  prompt: z.string().max(4000),
  negative: z.string().max(4000),
  adapters: z.array(mangaAdapterSchema).max(8),
  modelBundleId: z.string().max(200).optional(),
  steps: z.number().int().min(1).max(200),
  cfg: z.number().min(0).max(30),
})

export const READING_DIRECTIONS = ['rtl', 'ltr'] as const

export const mangaSeriesSchema = z.object({
  schemaVersion: z.literal(MANGA_SCHEMA_VERSION),
  id,
  title: z.string().min(1).max(120),
  logline: z.string().max(4000),
  readingDirection: z.enum(READING_DIRECTIONS),
  /** The Studio project whose assets folder holds this series' pictures. */
  projectId: id,
  /** The language model the storyboard uses; absent = the first connected one. */
  providerId: z.string().max(120).optional(),
  style: mangaStyleSchema,
  characters: z.array(mangaCharacterSchema).max(100),
  chapters: z.array(mangaChapterSchema).max(2000),
  facts: z.array(mangaFactSchema).max(500),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type MangaAdapter = z.infer<typeof mangaAdapterSchema>
export type MangaImage = z.infer<typeof mangaImageSchema>
export type MangaOutfit = z.infer<typeof mangaOutfitSchema>
export type MangaCharacter = z.infer<typeof mangaCharacterSchema>
export type MangaBalloon = z.infer<typeof mangaBalloonSchema>
export type MangaCast = z.infer<typeof mangaCastSchema>
export type MangaTake = z.infer<typeof mangaTakeSchema>
export type MangaPanel = z.infer<typeof mangaPanelSchema>
export type MangaPage = z.infer<typeof mangaPageSchema>
export type MangaChapter = z.infer<typeof mangaChapterSchema>
export type MangaFact = z.infer<typeof mangaFactSchema>
export type MangaStyle = z.infer<typeof mangaStyleSchema>
export type MangaSeries = z.infer<typeof mangaSeriesSchema>

/** What main receives on save: the document without what main owns. */
export const mangaSeriesSaveSchema = mangaSeriesSchema
  .omit({ schemaVersion: true, createdAt: true, updatedAt: true, projectId: true })
  .extend({
    id: id.optional(),
    projectId: id.optional(),
  })
export type MangaSeriesSave = z.infer<typeof mangaSeriesSaveSchema>

export interface MangaSeriesSummary {
  id: string
  title: string
  logline: string
  chapterCount: number
  characterCount: number
  /** Panels with an approved picture, of all panels. */
  approved: number
  panels: number
  updatedAt: string
}

export function seriesSummary(series: MangaSeries): MangaSeriesSummary {
  const panels = series.chapters.flatMap((chapter) => chapter.pages.flatMap((page) => page.panels))
  return {
    id: series.id,
    title: series.title,
    logline: series.logline,
    chapterCount: series.chapters.length,
    characterCount: series.characters.length,
    approved: panels.filter((panel) => panel.state === 'approved').length,
    panels: panels.length,
    updatedAt: series.updatedAt,
  }
}

/** A short random id for a new character, chapter, page, panel or balloon. */
export function newId(prefix: string, random: () => number = Math.random): string {
  return `${prefix}-${Math.floor(random() * 0xffffffff)
    .toString(36)
    .padStart(6, '0')}${Date.now().toString(36).slice(-4)}`
}

export function emptyPanel(id: string): MangaPanel {
  return { id, scene: '', shot: 'medium', cast: [], dialogue: [], state: 'draft', attempts: 0, takes: [] }
}

export function emptyCharacter(id: string, name: string): MangaCharacter {
  return {
    id,
    name,
    role: '',
    appearance: '',
    personality: '',
    triggerWords: '',
    references: [],
    outfits: [],
    adapters: [],
  }
}

/** The picture a panel shows: the approved take, else the newest. */
export function panelPicture(panel: Pick<MangaPanel, 'takes' | 'chosen'>): MangaTake | undefined {
  if (panel.chosen !== undefined && panel.takes[panel.chosen]) return panel.takes[panel.chosen]
  return panel.takes.at(-1)
}
