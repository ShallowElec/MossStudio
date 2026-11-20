import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  MANGA_SCHEMA_VERSION,
  mangaSeriesSchema,
  seriesSummary,
  type MangaSeries,
  type MangaSeriesSave,
  type MangaSeriesSummary,
} from '@shared/manga/model'
import { codedError } from '../lib/codedError'
import { paths } from '../lib/paths'
import { PROJECT_ID_PATTERN, deleteProject, getProject, saveProject } from './projects'

/**
 * 漫画 series on disk: one `manga/<id>.json` per series, validated on every
 * read. Each series owns a Studio project (`漫画 · <title>`) whose assets
 * folder holds its reference pictures, so importing, showing and sending
 * those pictures to the engine goes through the Studio's checked paths.
 */

const SERIES_FILE = /^(manga-[A-Za-z0-9_-]{1,100})\.json$/

function root(): string {
  return join(paths.root(), 'manga')
}

function seriesFile(id: string): string {
  if (!PROJECT_ID_PATTERN.test(id) || !id.startsWith('manga-')) throw codedError('E_INPUT', '漫画无效，请重新打开')
  return join(root(), `${id}.json`)
}

function readSeries(id: string): MangaSeries | null {
  try {
    const parsed = mangaSeriesSchema.safeParse(JSON.parse(readFileSync(seriesFile(id), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function writeSeries(series: MangaSeries): void {
  mkdirSync(root(), { recursive: true })
  const file = seriesFile(series.id)
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(series, null, 2), 'utf8')
  renameSync(temporary, file)
}

export function listSeries(): MangaSeriesSummary[] {
  try {
    return readdirSync(root())
      .map((name) => SERIES_FILE.exec(name)?.[1])
      .filter((id): id is string => Boolean(id))
      .map(readSeries)
      .filter((series): series is MangaSeries => Boolean(series))
      .map(seriesSummary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

/**
 * Before 设置 › 语言模型, a series without its own model used the newest
 * connection. The settings migration pins that one on such series once, so they
 * keep it when 助手和漫画 becomes the default. `updatedAt` is left alone.
 */
export function pinSeriesProvider(providerId: string): void {
  let names: string[]
  try {
    names = readdirSync(root())
  } catch {
    return // no series yet
  }
  for (const name of names) {
    const id = SERIES_FILE.exec(name)?.[1]
    const series = id ? readSeries(id) : null
    if (series && !series.providerId) writeSeries({ ...series, providerId })
  }
}

export function getSeries(id: string): MangaSeries | null {
  return readSeries(id)
}

const projectName = (title: string): string => `漫画 · ${title}`.slice(0, 200)

export function saveSeries(input: MangaSeriesSave): MangaSeries {
  const existing = input.id ? readSeries(input.id) : null
  if (input.id && !existing) throw codedError('E_NOT_FOUND', '这部漫画已经删除了')
  const now = new Date().toISOString()
  const title = input.title.trim() || '未命名漫画'
  const id = existing?.id ?? `manga-${randomUUID().slice(0, 8)}`
  // The backing project is made once; a project deleted from the Studio is made again.
  const project = existing ? getProject(existing.projectId) : null
  const projectId = !project
    ? saveProject({ name: projectName(title), canvases: [], seriesId: id }).id
    : project.name !== projectName(title)
      ? saveProject({ ...project, name: projectName(title) }).id
      : project.id
  const series = mangaSeriesSchema.parse({
    ...input,
    schemaVersion: MANGA_SCHEMA_VERSION,
    id,
    title,
    projectId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  writeSeries(series)
  return series
}

export function deleteSeries(id: string): void {
  const series = readSeries(id)
  if (series) deleteProject(series.projectId)
  rmSync(seriesFile(id), { force: true })
}

/** File names of an exported chapter: `第 3 话-01.png`, numbered from 01 in reading order. */
export function exportFileNames(chapterNumber: number, count: number): string[] {
  const digits = Math.max(2, String(count).length)
  return Array.from({ length: count }, (_, index) => `第${chapterNumber}话-${String(index + 1).padStart(digits, '0')}.png`)
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Write a chapter's finished pages into `folder/<series title>/`; returns that folder. */
export function writeChapterPages(folder: string, input: { title: string; chapterNumber: number; pages: Uint8Array[] }): string {
  if (!input.pages.length) throw codedError('E_INPUT', '这一话还没有页面')
  for (const page of input.pages) {
    if (!PNG_SIGNATURE.every((byte, index) => page[index] === byte)) throw codedError('E_INPUT', '页面图片无效，请重新导出')
  }
  // The title names a folder: no separators, characters Windows refuses, or `.` / `..`, which would leave the chosen folder.
  const cleaned = input.title.replace(/[\\/:*?"<>|]/g, '_').trim()
  const safeTitle = cleaned && !/^\.+$/.test(cleaned) ? cleaned : '漫画'
  const target = join(folder, safeTitle)
  if (dirname(resolve(target)) !== resolve(folder)) throw codedError('E_INPUT', '导出文件夹无效')
  mkdirSync(target, { recursive: true })
  const names = exportFileNames(input.chapterNumber, input.pages.length)
  input.pages.forEach((page, index) => writeFileSync(join(target, names[index]!), page))
  return target
}
