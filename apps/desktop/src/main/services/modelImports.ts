import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

export type ImportedModelRole = 'full' | 'dit' | 'text_encoder' | 'vae' | 'support'

export interface ImportedModelFile {
  id: string
  name: string
  path: string
  relativePath: string
  /** Missing for files registered by a directory scan: hashing 27 GB up front is unusable. */
  sha256?: string
  size: number
  mtimeMs: number
  role: ImportedModelRole
  /** Set by a directory scan: a diffusers folder vs a single ComfyUI weights file. */
  layout?: 'comfyui-single-file' | 'diffusers-folder'
  /** What the engine's `inspect` named the weights when the file was imported. */
  precision?: string
  /** The catalog part this file is (same name and size): it stands in for that part instead of being listed on its own. */
  catalogId?: string
  /** The engine's `inspect` recognised the file in this role (导入模型); older registrations went by folder names. */
  inspected?: boolean
  /** A main model's `load` tiers as `inspect` named them. */
  tiers?: string[]
  importedAt: string
}

interface ImportIndex {
  schema_version: 1 | 2
  models: ImportedModelFile[]
}

const skippedDirectories = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', 'cache', 'input', 'output', 'temp'])
const maxFiles = 5000

function isImportedModelFile(value: unknown): value is ImportedModelFile {
  if (!value || typeof value !== 'object') return false
  const model = value as Partial<ImportedModelFile>
  return (
    typeof model.id === 'string' &&
    typeof model.name === 'string' &&
    typeof model.path === 'string' &&
    typeof model.relativePath === 'string' &&
    (model.sha256 === undefined || /^[a-f0-9]{64}$/.test(model.sha256)) &&
    Number.isSafeInteger(model.size) &&
    (model.size ?? 0) > 0 &&
    typeof model.mtimeMs === 'number' &&
    Number.isFinite(model.mtimeMs) &&
    ['full', 'dit', 'text_encoder', 'vae', 'support'].includes(model.role ?? '') &&
    (model.layout === undefined || ['comfyui-single-file', 'diffusers-folder'].includes(model.layout)) &&
    (model.precision === undefined || typeof model.precision === 'string') &&
    (model.catalogId === undefined || typeof model.catalogId === 'string') &&
    (model.inspected === undefined || typeof model.inspected === 'boolean') &&
    (model.tiers === undefined || (Array.isArray(model.tiers) && model.tiers.every((tier) => typeof tier === 'string'))) &&
    typeof model.importedAt === 'string'
  )
}

export async function readImportedModels(indexFile: string): Promise<ImportedModelFile[]> {
  let content: string
  try {
    content = await readFile(indexFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const index = JSON.parse(content) as Partial<ImportIndex>
  if (
    (index.schema_version !== 1 && index.schema_version !== 2) ||
    !Array.isArray(index.models) ||
    !index.models.every(isImportedModelFile)
  ) {
    throw new Error('本地模型导入记录无效')
  }
  return index.models
}

async function writeImportedModels(indexFile: string, models: ImportedModelFile[]): Promise<void> {
  await mkdir(dirname(indexFile), { recursive: true })
  const temporary = `${indexFile}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ schema_version: 2, models }, null, 2), 'utf8')
    await rename(temporary, indexFile)
  } finally {
    await rm(temporary, { force: true })
  }
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/* ------------------------------------------------------------------ */
/* Diffusers folders, registered in place                              */
/* ------------------------------------------------------------------ */

export interface DiffusersFolderInfo {
  /** Bytes of every file in the folder (what the registration checks later). */
  size: number
  mtimeMs: number
  /** Which MOSS-Image this is, from README's title or the folder name; null when unknown. */
  flavor: 'sft' | 'base' | null
  /** Weight dtype read from the transformer's safetensors header: `bf16`, `fp16`, `fp32`. */
  dtype: string | null
  /** Every file, relative to the folder, with its size (what the catalog components are matched against). */
  files: Array<{ path: string; size: number }>
}

const DTYPES: Record<string, string> = { BF16: 'bf16', F16: 'fp16', F32: 'fp32' }

/** The dtype of the first tensor in a safetensors file: 8-byte header length, then a JSON header. */
async function safetensorsDtype(file: string): Promise<string | null> {
  try {
    const handle = await open(file, 'r')
    try {
      const head = Buffer.alloc(8)
      await handle.read(head, 0, 8, 0)
      const length = Number(head.readBigUInt64LE(0))
      if (!Number.isSafeInteger(length) || length <= 0 || length > 64 * 1024 * 1024) return null
      const json = Buffer.alloc(length)
      await handle.read(json, 0, length, 8)
      const header = JSON.parse(json.toString('utf8')) as Record<string, { dtype?: string; data_offsets?: [number, number] }>
      // The dtype holding most of the bytes (norms and scales are often kept in fp32).
      const bytes = new Map<string, number>()
      for (const [name, tensor] of Object.entries(header)) {
        if (name === '__metadata__' || !tensor?.dtype) continue
        const [start, end] = tensor.data_offsets ?? [0, 0]
        bytes.set(tensor.dtype, (bytes.get(tensor.dtype) ?? 0) + Math.max(0, end - start))
      }
      const top = [...bytes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      return top ? (DTYPES[top] ?? top.toLowerCase()) : null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function listFolder(root: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const files: Array<{ path: string; size: number; mtimeMs: number }> = []
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 4) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !skippedDirectories.has(entry.name.toLowerCase())) await visit(absolute, depth + 1)
      } else if (entry.isFile()) {
        const info = await stat(absolute)
        files.push({ path: relative(root, absolute).split(/[\\/]/).join('/'), size: info.size, mtimeMs: info.mtimeMs })
      }
      if (files.length > maxFiles) throw new Error(`模型文件夹里的文件超过 ${maxFiles} 个`)
    }
  }
  await visit(root, 0)
  return files
}

/**
 * A complete diffusers folder: model_index.json, and transformer/,
 * text_encoder/ and vae/ each with config.json and safetensors weights.
 * Null for anything else.
 */
export async function inspectDiffusersFolder(directory: string): Promise<DiffusersFolderInfo | null> {
  let files: Array<{ path: string; size: number; mtimeMs: number }>
  try {
    if (!(await stat(directory)).isDirectory()) return null
    files = await listFolder(directory)
  } catch {
    return null
  }
  const has = (path: string): boolean => files.some((file) => file.path === path && file.size > 0)
  if (!has('model_index.json')) return null
  for (const part of ['transformer', 'text_encoder', 'vae']) {
    if (!has(`${part}/config.json`)) return null
    if (!files.some((file) => file.path.startsWith(`${part}/`) && file.path.endsWith('.safetensors') && file.size > 0)) return null
  }
  let flavor: DiffusersFolderInfo['flavor'] = null
  try {
    const title = /^#\s+(.+)$/m.exec(await readFile(join(directory, 'README.md'), 'utf8'))?.[1] ?? ''
    if (/MOSS-Image-SFT/i.test(title)) flavor = 'sft'
    else if (/MOSS-Image-Base/i.test(title)) flavor = 'base'
  } catch {
    /* no README */
  }
  if (!flavor) {
    const name = basename(directory).toLowerCase()
    if (/(^|[^a-z])sft([^a-z]|$)/.test(name)) flavor = 'sft'
    else if (/(^|[^a-z])base([^a-z]|$)/.test(name)) flavor = 'base'
  }
  const shard = files
    .filter((file) => file.path.startsWith('transformer/') && file.path.endsWith('.safetensors'))
    .sort((a, b) => a.path.localeCompare(b.path))[0]
  const index = files.find((file) => file.path === 'model_index.json')!
  return {
    size: files.reduce((sum, file) => sum + file.size, 0),
    mtimeMs: index.mtimeMs,
    flavor,
    dtype: shard ? await safetensorsDtype(join(directory, shard.path)) : null,
    files: files.map(({ path, size }) => ({ path, size })),
  }
}

/** What people see for a diffusers folder: the MOSS-Image it is, or the folder name. */
export function diffusersFolderName(directory: string, flavor: DiffusersFolderInfo['flavor']): string {
  if (flavor === 'sft') return `MOSS-Image SFT（${basename(directory)}）`
  if (flavor === 'base') return `MOSS-Image Base（${basename(directory)}）`
  return basename(directory)
}

/** Every change to the index reads it, changes it and writes it back, so changes run one at a time. */
let writing: Promise<unknown> = Promise.resolve()
function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = writing.then(task)
  // The next change waits for this one, whether it worked or not.
  writing = run.catch(() => undefined)
  return run
}

/**
 * The record of an id: its own, else the one standing in for that catalog part. There is one stand-in
 * per part (registering another takes the part over); of several left by an older version, the last.
 */
export function importedRecord(models: readonly ImportedModelFile[], id: string): ImportedModelFile | undefined {
  return models.find((model) => model.id === id) ?? [...models].reverse().find((model) => model.catalogId === id)
}

export function removeImportedModel(indexFile: string, id: string): Promise<void> {
  return inTurn(async () => {
    const models = await readImportedModels(indexFile)
    const record = importedRecord(models, id)
    if (!record) throw new Error('本地导入模型记录不存在')
    await writeImportedModels(
      indexFile,
      models.filter((model) => model !== record),
    )
  })
}

export interface ScannedRegistration {
  path: string
  role: ImportedModelRole
  name?: string
  relativePath?: string
  layout?: 'comfyui-single-file' | 'diffusers-folder'
  precision?: string
  catalogId?: string
  inspected?: boolean
  tiers?: string[]
}

export interface RegisterScanResult {
  added: number
  updated: number
  missing: string[]
  /** The registered entry id of each item, in order; null for an item whose file is gone. */
  ids: Array<string | null>
}

/**
 * Register files found by `modelScan`. No hashing and no copying: the user's
 * ComfyUI folder is only read, and the record points at the original file.
 * Re-registering the same path updates its role/size instead of adding a row.
 */
export function registerScannedModels(indexFile: string, items: ScannedRegistration[]): Promise<RegisterScanResult> {
  return inTurn(() => register(indexFile, items))
}

async function register(indexFile: string, items: ScannedRegistration[]): Promise<RegisterScanResult> {
  const models = await readImportedModels(indexFile)
  const byPath = new Map(models.map((model) => [model.path.toLowerCase(), model]))
  const result: RegisterScanResult = { added: 0, updated: 0, missing: [], ids: [] }
  for (const item of items) {
    let path: string
    try {
      path = await realpath(resolve(item.path))
    } catch {
      result.missing.push(item.path)
      result.ids.push(null)
      continue
    }
    const existing = byPath.get(path.toLowerCase())
    const layout = item.layout ?? existing?.layout
    // A diffusers folder is one model, used where it is (nothing copied); a weights file is one file.
    let size: number
    let mtimeMs: number
    let name = item.name
    if (layout === 'diffusers-folder') {
      const folder = await inspectDiffusersFolder(path)
      if (!folder) {
        result.missing.push(item.path)
        result.ids.push(null)
        continue
      }
      size = folder.size
      mtimeMs = folder.mtimeMs
      if (!name || name === '.') name = diffusersFolderName(path, folder.flavor)
    } else {
      const info = await stat(path).catch(() => null)
      if (!info || !info.isFile() || info.size <= 0) {
        result.missing.push(item.path)
        result.ids.push(null)
        continue
      }
      size = info.size
      mtimeMs = info.mtimeMs
    }
    const relativePath = item.relativePath && item.relativePath !== '.' ? item.relativePath : basename(path)
    const catalogId = item.catalogId ?? existing?.catalogId
    // One stand-in per catalog part: a file registered for it takes it over from any other.
    if (item.catalogId) {
      for (const [index, other] of models.entries()) {
        if (other !== existing && other.catalogId === item.catalogId) {
          const { catalogId: _taken, ...rest } = other
          models[index] = rest
          byPath.set(other.path.toLowerCase(), rest)
        }
      }
    }
    const record: ImportedModelFile = {
      id: existing?.id ?? `local-scan-${createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 20)}`,
      name: name ?? basename(path),
      path,
      relativePath,
      size,
      mtimeMs,
      role: item.role,
      importedAt: existing?.importedAt ?? new Date().toISOString(),
      ...(layout ? { layout } : {}),
      ...(item.precision ? { precision: item.precision } : {}),
      ...(item.tiers?.length ? { tiers: item.tiers } : {}),
      ...(catalogId ? { catalogId } : {}),
      ...(item.inspected || existing?.inspected ? { inspected: true } : {}),
      ...(existing?.sha256 ? { sha256: existing.sha256 } : {}),
    }
    if (existing) {
      models.splice(models.indexOf(existing), 1, record)
      result.updated += 1
    } else {
      models.push(record)
      result.added += 1
    }
    byPath.set(path.toLowerCase(), record)
    result.ids.push(record.id)
  }
  if (result.added || result.updated) await writeImportedModels(indexFile, models)
  return result
}

/** What the engine said about the file picked in 重新找到…, and the catalog part it is (null: none). */
export interface RelocatedFacts {
  precision?: string
  tiers?: string[]
  catalogId: string | null
}

/**
 * 重新找到…: the record keeps its id (so every combination and 画面 using it keeps
 * working) and now points at the file where it is, with what the engine says that
 * file is: a file that is not the catalog part any more stops standing in for it.
 */
export function relocateImportedModel(indexFile: string, id: string, path: string, facts: RelocatedFacts): Promise<ImportedModelFile> {
  return inTurn(async () => {
    const models = await readImportedModels(indexFile)
    const existing = importedRecord(models, id)
    if (!existing) throw new Error('本地导入模型记录不存在')
    const actual = await realpath(resolve(path))
    const info = await stat(actual)
    if (!info.isFile() || info.size <= 0) throw new Error('请选择模型文件')
    const { sha256: _hash, catalogId: _part, precision: _precision, tiers: _tiers, ...rest } = existing
    const record: ImportedModelFile = {
      ...rest,
      name: basename(actual),
      path: actual,
      relativePath: basename(actual),
      size: info.size,
      mtimeMs: info.mtimeMs,
      inspected: true,
      ...(facts.precision ? { precision: facts.precision } : {}),
      ...(facts.tiers?.length ? { tiers: facts.tiers } : {}),
      ...(facts.catalogId ? { catalogId: facts.catalogId } : {}),
    }
    await writeImportedModels(
      indexFile,
      models.map((model) => (model === existing ? record : model)),
    )
    return record
  })
}

export async function verifyImportedModelFile(model: ImportedModelFile, sha256: string, size: number): Promise<boolean> {
  // Records registered by a scan carry no hash; they cannot be matched to an HF
  // blob by content, so the caller falls back to downloading it.
  if (!model.sha256 || model.sha256 !== sha256 || model.size !== size) return false
  try {
    const info = await stat(model.path)
    return info.isFile() && info.size === size && (await hashFile(model.path)) === sha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
