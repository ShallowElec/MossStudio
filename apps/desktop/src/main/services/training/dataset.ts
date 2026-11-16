/**
 * A training's pictures: copies in its own `images/` folder with a same-stem `.txt` description
 * each (the trainer's `folder_nl` layout), so editing descriptions never touches the originals.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { SMALL_PICTURE_SIDE, type DatasetImage, type TrainingDataset, type TrainingProject } from '@shared/training'
import { codedError } from '../../lib/codedError'
import { writeFileAtomic } from '../../lib/atomicWrite'
import { readImageHeader } from '../imageHeaders'
import { imagesDir, projectDir, TRAINING_IMAGE_EXT, whileEditable } from './store'

/** What a run reads, rebuilt at each start: see stageDataset. */
export function stagedDir(id: string): string {
  return join(projectDir(id), 'dataset')
}

/** Enough of a file for its size: a JPEG's frame header can sit behind a large EXIF block. */
const HEADER_BYTES = 256 * 1024

function stemOf(name: string): string {
  return name.slice(0, name.length - extname(name).length)
}

function isImage(name: string): boolean {
  return TRAINING_IMAGE_EXT.has(extname(name).toLowerCase())
}

/** A picture name from the renderer: one file in the folder, nothing that climbs out of it. */
function safeName(name: string): string {
  if (!name || name !== basename(name) || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw codedError('E_TRAINING_PICTURE', '图片名不对，请刷新后再试。')
  }
  return name
}

async function readHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const hashes = new Map<string, { key: string; hash: string }>()

/** Content hash, remembered per path while the file's size and time stay the same. */
async function contentHash(file: string): Promise<string> {
  const info = await stat(file)
  const key = `${info.size}:${info.mtimeMs}`
  const cached = hashes.get(file)
  if (cached?.key === key) return cached.hash
  const hash = await new Promise<string>((resolve, reject) => {
    const digest = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => digest.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(digest.digest('hex')))
  })
  hashes.set(file, { key, hash })
  return hash
}

async function readCaption(dir: string, name: string): Promise<string | null> {
  try {
    return (await readFile(join(dir, `${stemOf(name)}.txt`), 'utf8')).replace(/^\uFEFF/, '').trim()
  } catch {
    return null
  }
}

async function describe(dir: string, name: string): Promise<Omit<DatasetImage, 'problems'> & { hash: string }> {
  const path = join(dir, name)
  const header = readImageHeader(await readHead(path))
  return {
    name,
    path,
    width: header?.width ?? 0,
    height: header?.height ?? 0,
    caption: await readCaption(dir, name),
    hash: await contentHash(path),
  }
}

export async function scanDataset(id: string): Promise<TrainingDataset> {
  const dir = imagesDir(id)
  let names: string[]
  try {
    names = (await readdir(dir)).filter(isImage)
  } catch {
    names = []
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const described = await Promise.all(names.map((name) => describe(dir, name)))
  const firstOf = new Map<string, number>()
  const images: DatasetImage[] = described.map(({ hash, ...image }, index) => {
    const problems: DatasetImage['problems'] = []
    if (Math.min(image.width, image.height) < SMALL_PICTURE_SIDE) problems.push('small')
    const first = firstOf.get(hash)
    if (first === undefined) firstOf.set(hash, index + 1)
    else problems.push('duplicate')
    return first === undefined ? { ...image, problems } : { ...image, problems, duplicateOf: first }
  })
  return {
    images,
    counts: {
      total: images.length,
      small: images.filter((image) => image.problems.includes('small')).length,
      duplicate: images.filter((image) => image.problems.includes('duplicate')).length,
      noCaption: images.filter((image) => !image.caption).length,
    },
  }
}

async function collect(path: string, out: string[]): Promise<void> {
  const info = await stat(path)
  if (info.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory() || entry.isFile()) await collect(join(path, entry.name), out)
    }
  } else if (info.isFile() && isImage(path)) out.push(path)
}

/** A file name whose stem no picture in `taken` uses yet (compared without case, as Windows does). */
function freeName(name: string, taken: Set<string>): string {
  const ext = extname(name).toLowerCase()
  const stem =
    stemOf(name)
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim() || 'image'
  let candidate = stem
  for (let index = 2; taken.has(candidate.toLowerCase()); index += 1) candidate = `${stem}-${index}`
  taken.add(candidate.toLowerCase())
  return `${candidate}${ext}`
}

/** Copies pictures (files, or every picture inside folders) and their `.txt` descriptions in. */
export async function addToDataset(id: string, sources: string[]): Promise<TrainingDataset> {
  const files: string[] = []
  for (const source of sources) {
    try {
      await collect(source, files)
    } catch (error) {
      console.warn('[training]', `skipped ${source}:`, error instanceof Error ? error.message : error)
    }
  }
  await whileEditable(id, async () => {
    const dir = imagesDir(id)
    const taken = new Set(
      (await readdir(dir).catch(() => [] as string[]))
        .filter((name) => isImage(name) || name.endsWith('.txt'))
        .map((name) => stemOf(name).toLowerCase()),
    )
    for (const file of files) {
      // A file with a picture's name but no picture inside would stop the trainer.
      if (!readImageHeader(await readHead(file).catch(() => new Uint8Array()))) continue
      const name = freeName(basename(file), taken)
      await copyFile(file, join(dir, name))
      const sidecar = join(dirname(file), `${stemOf(basename(file))}.txt`)
      await copyFile(sidecar, join(dir, `${stemOf(name)}.txt`)).catch(() => undefined)
    }
  })
  return scanDataset(id)
}

export async function removeFromDataset(id: string, names: string[]): Promise<TrainingDataset> {
  const safe = names.map(safeName)
  await whileEditable(id, async () => {
    const dir = imagesDir(id)
    for (const name of safe) {
      if (!isImage(name)) continue
      await rm(join(dir, name), { force: true })
      await rm(join(dir, `${stemOf(name)}.txt`), { force: true })
    }
  })
  return scanDataset(id)
}

/** Writes one description; an empty one removes the `.txt`. */
export async function setCaption(id: string, name: string, caption: string): Promise<DatasetImage> {
  const dir = imagesDir(id)
  safeName(name)
  if (!isImage(name)) throw codedError('E_TRAINING_PICTURE', '图片名不对，请刷新后再试。')
  await whileEditable(id, async () => {
    await stat(join(dir, name)).catch(() => {
      throw codedError('E_TRAINING_PICTURE', '这张图片已经不在了，请刷新后再试。')
    })
    const text = caption.replace(/\r\n?/g, '\n').trim()
    const file = join(dir, `${stemOf(name)}.txt`)
    if (text) await writeFileAtomic(file, `${text}\n`)
    else await rm(file, { force: true })
  })
  const image = (await scanDataset(id)).images.find((item) => item.name === name)
  if (!image) throw codedError('E_TRAINING_PICTURE', '这张图片已经不在了，请刷新后再试。')
  return image
}

/** Writes several descriptions at once (自动描述), unless a run started meanwhile. */
export async function writeCaptions(id: string, captions: Map<string, string>): Promise<void> {
  for (const name of captions.keys()) safeName(name)
  await whileEditable(id, async () => {
    const dir = imagesDir(id)
    for (const [name, caption] of captions) await writeFileAtomic(join(dir, `${stemOf(name)}.txt`), `${caption.trim()}\n`)
  })
}

/** Whether `caption` already names the trigger as a word of its own. */
export function mentionsTrigger(caption: string, trigger: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${trigger}($|[^A-Za-z0-9_])`).test(caption)
}

/** The description a run trains on: for 人物 and 物品 the subject is always called by its trigger. */
export function runCaption(caption: string | null, kind: TrainingProject['kind'], trigger: string): string {
  const text = caption?.trim() ?? ''
  if (kind === 'style' || !trigger) return text
  if (!text) return trigger
  return mentionsTrigger(text, trigger) ? text : `${trigger}，${text}`
}

/**
 * The folder a run reads: the pictures linked (copied where a link cannot be made) next to the
 * descriptions it trains on. The person's own descriptions stay as they wrote them.
 */
export async function stageDataset(project: Pick<TrainingProject, 'id' | 'kind' | 'trigger'>): Promise<string> {
  const target = stagedDir(project.id)
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const image of (await scanDataset(project.id)).images) {
    const linked = join(target, image.name)
    await link(image.path, linked).catch(() => copyFile(image.path, linked))
    const caption = runCaption(image.caption, project.kind, project.trigger)
    if (caption) await writeFile(join(target, `${stemOf(image.name)}.txt`), `${caption}\n`, 'utf8')
  }
  return target
}
