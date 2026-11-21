import { copyFile, mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import type { LoraMetadata, LoraProfile } from '@shared/types'
import { schemas } from '@shared/schemas'
import { paths } from '../lib/paths'
import { writeFileAtomic } from '../lib/atomicWrite'
import { isNetworkPath, pathLinksToNetwork } from '../lib/localPath'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
function words(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\r\n]+/) : []
  return [
    ...new Set(
      values
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= 200),
    ),
  ].slice(0, 64)
}
export function sanitizeLoraMetadata(value: unknown): LoraMetadata {
  const row = object(value)
  return {
    ...(row.triggers !== undefined ? { triggers: words(row.triggers) } : {}),
    ...(row.suggestedTriggers !== undefined ? { suggestedTriggers: words(row.suggestedTriggers).slice(0, 8) } : {}),
    ...(row.negativeTriggers !== undefined ? { negativeTriggers: words(row.negativeTriggers) } : {}),
    ...(typeof row.defaultStrength === 'number' && Number.isFinite(row.defaultStrength) && Math.abs(row.defaultStrength) <= 4
      ? { defaultStrength: row.defaultStrength }
      : {}),
    ...(['manual', 'prefix', 'suffix'].includes(String(row.autoInsert))
      ? { autoInsert: row.autoInsert as LoraMetadata['autoInsert'] }
      : {}),
    ...(typeof row.notes === 'string' ? { notes: row.notes.slice(0, 4000) } : {}),
  }
}
async function sidecar(file: string): Promise<string | undefined> {
  try {
    const handle = await open(file, 'r')
    try {
      if ((await handle.stat()).size > 1024 * 1024) return undefined
      return await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
export async function extractSafetensorsTriggers(filePath: string): Promise<LoraMetadata> {
  if (extname(filePath).toLowerCase() !== '.safetensors') throw new Error('请选择 safetensors 文件。')
  const handle = await open(filePath, 'r')
  let metadata: Record<string, unknown>
  try {
    const prefix = Buffer.alloc(8)
    if ((await handle.read(prefix, 0, 8, 0)).bytesRead !== 8) throw new Error('LoRA 文件头不完整。')
    const length = prefix.readBigUInt64LE()
    if (length < 2n || length > 16n * 1024n * 1024n) throw new Error('LoRA 文件头大小无效。')
    const header = Buffer.alloc(Number(length))
    if ((await handle.read(header, 0, header.length, 8)).bytesRead !== header.length) throw new Error('LoRA 文件头不完整。')
    metadata = object(object(JSON.parse(header.toString('utf8')) as unknown).__metadata__)
  } finally {
    await handle.close()
  }
  let triggers: string[] = []
  for (const key of ['modelspec.trigger_word', 'trigger_word', 'trigger_words']) {
    triggers = words(metadata[key])
    if (triggers.length) break
  }
  const stem = filePath.slice(0, -extname(filePath).length)
  for (const suffix of ['.civitai.info', '.json', '.txt']) {
    if (triggers.length) break
    const value = await sidecar(stem + suffix)
    if (value === undefined) continue
    if (suffix === '.txt') {
      triggers = words(value)
      continue
    }
    try {
      const row = object(JSON.parse(value) as unknown)
      for (const key of suffix === '.civitai.info' ? ['trainedWords'] : ['triggers', 'trainedWords', 'activation text']) {
        triggers = words(row[key])
        if (triggers.length) break
      }
    } catch {
      /* Malformed optional sidecars do not hide lower-priority metadata. */
    }
  }
  const frequencies = new Map<string, number>()
  try {
    const raw =
      typeof metadata.ss_tag_frequency === 'string' ? (JSON.parse(metadata.ss_tag_frequency) as unknown) : metadata.ss_tag_frequency
    for (const group of Object.values(object(raw)))
      for (const [tag, count] of Object.entries(object(group))) {
        if (words([tag]).length && typeof count === 'number' && Number.isFinite(count) && count > 0)
          frequencies.set(tag.trim(), (frequencies.get(tag.trim()) ?? 0) + count)
      }
  } catch {
    /* Training frequency is only a suggestion, never an explicit trigger. */
  }
  return {
    triggers,
    suggestedTriggers: [...frequencies]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tag]) => tag),
  }
}
/**
 * The saved profiles. Each row is checked on its own: a bad row is skipped, the
 * others stay. `damaged` says the file could not be read as it was written, so
 * the next save backs it up before replacing it.
 */
async function readProfiles(): Promise<{ rows: LoraProfile[]; damaged: boolean }> {
  let raw: string
  try {
    raw = await readFile(paths.loraProfiles(), 'utf8')
  } catch (error) {
    // Optional metadata must not make the model inventory unavailable: an unreadable file reads as none, kept aside on save.
    return { rows: [], damaged: (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Optional metadata must not make the model inventory unavailable.
    return { rows: [], damaged: true }
  }
  if (!Array.isArray(parsed)) return { rows: [], damaged: true }
  const rows: LoraProfile[] = []
  for (const row of parsed) {
    const checked = schemas.loraProfilesSave.safeParse(row)
    if (checked.success) rows.push(checked.data)
  }
  return { rows, damaged: rows.length !== parsed.length }
}

export async function listLoraProfiles(): Promise<LoraProfile[]> {
  return (await readProfiles()).rows
}

export async function getLoraProfile(loraId: string): Promise<LoraProfile | undefined> {
  return (await listLoraProfiles()).find((row) => row.loraId === loraId)
}
let writeQueue: Promise<unknown> = Promise.resolve()
export function saveLoraProfile(input: LoraProfile): Promise<LoraProfile> {
  const profile = schemas.loraProfilesSave.parse(input)
  const task = writeQueue.then(async () => {
    const { rows, damaged } = await readProfiles()
    const existing = rows.find((row) => row.loraId === profile.loraId)
    const merged = { ...existing, ...profile }
    await mkdir(dirname(paths.loraProfiles()), { recursive: true })
    // Rows that could not be read are kept in a copy instead of being lost with this write.
    if (damaged) await copyFile(paths.loraProfiles(), `${paths.loraProfiles()}.damaged-${Date.now()}`)
    await writeFileAtomic(paths.loraProfiles(), JSON.stringify([...rows.filter((row) => row.loraId !== profile.loraId), merged], null, 2))
    return merged
  })
  writeQueue = task.catch(() => undefined)
  return task
}
/** Trigger words read from a LoRA file, by path; reused while its size and modification time stay the same. */
const triggerCache = new Map<string, { size: number; mtimeMs: number; metadata: LoraMetadata }>()

/** The file's trigger words, read once per version of the file. A network path is never opened. */
export async function cachedSafetensorsTriggers(filePath: string): Promise<LoraMetadata> {
  if (isNetworkPath(filePath) || (await pathLinksToNetwork(filePath))) return {}
  const info = await stat(filePath)
  const cached = triggerCache.get(filePath)
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.metadata
  const metadata = await extractSafetensorsTriggers(filePath)
  triggerCache.set(filePath, { size: info.size, mtimeMs: info.mtimeMs, metadata })
  return metadata
}

export async function mergeLoraMeta<T extends { id: string }>(item: T, filePath?: string): Promise<T & LoraMetadata> {
  let extracted: LoraMetadata = {}
  if (filePath) {
    try {
      extracted = await cachedSafetensorsTriggers(filePath)
    } catch {
      /* Inventory remains usable for legacy or malformed files. */
    }
  }
  const profile = await getLoraProfile(item.id)
  return { ...item, ...sanitizeLoraMetadata(item), ...extracted, ...sanitizeLoraMetadata(profile) }
}
