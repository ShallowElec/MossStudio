import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { z } from 'zod'
import { basename, extname, join } from 'node:path'
import type {
  AdapterEntry,
  ControlAdapterEntry,
  ModelEntry,
  ModelImportProblem,
  ModelSource,
  ModelSourceFile,
  ModelSourceStatus,
  ModelSourcesView,
  ScannedModel,
  Settings,
} from '@shared/types'
import { SHARED_MODEL_PREFIX } from '@shared/sharedModels'
import { importProblemText, recognize } from '@shared/modelImport'
import { writeFileAtomic } from '../lib/atomicWrite'
import { isNetworkPath, modelPathKey } from '../lib/localPath'
import { isInside, paths } from '../lib/paths'
import { withEngineRequests, type EngineRequest } from '../lib/probeEngine'
import { localServerPath } from './engineInstalls'
import { inspectDiffusersFolder } from './modelImports'
import { legacyModelReady } from './modelReadiness'
import { scanModelDirectory } from './modelScan'
import { guessModelSourceKind, isTooBroadModelFolder, nearbyModelSources, sourceRoots } from './modelSourcePaths'
import { getSettings, updateSettings } from './settings'

const inspectionSchema = z.object({
  role: z.enum(['dit', 'text_encoder', 'vae', 'full', 'lora', 'control_adapter']),
  precision: z.string(),
  base: z.string().optional(),
  controlKinds: z.array(z.string()).optional(),
})
const cacheEntrySchema = z.object({ size: z.number(), mtimeMs: z.number(), value: z.union([inspectionSchema, z.string()]) })
const sourceKind = z.enum(['comfyui', 'webui', 'forge', 'custom'])
const discoveredSourceSchema = z.object({ kind: sourceKind, path: z.string() })
const scanFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  layout: z.enum(['comfyui-single-file', 'diffusers-folder', 'unknown']),
})
const sourceStatusSchema = discoveredSourceSchema.extend({
  id: z.string(),
  roots: z.array(z.string()),
  available: z.number(),
  pending: z.number(),
  incompatible: z.number(),
  issues: z.array(z.string()),
  files: z.array(
    scanFileSchema.pick({ path: true, name: true, size: true }).extend({
      role: z.enum(['dit', 'text_encoder', 'vae', 'support', 'full', 'lora', 'control_adapter']),
      state: z.enum(['available', 'pending', 'incompatible']),
      reason: z.string().optional(),
    }),
  ),
})
const indexSchema = z.object({
  engine: z.string(),
  files: z.record(z.string(), cacheEntrySchema),
  snapshot: z
    .object({
      key: z.string(),
      statuses: z.array(sourceStatusSchema),
      weights: z.array(z.object({ file: scanFileSchema, inspection: inspectionSchema, sourceIds: z.array(z.string()) })),
    })
    .optional(),
})
const discoverySchema = z.object({ sources: z.array(discoveredSourceSchema) })
type Inspection = z.infer<typeof inspectionSchema>

interface SharedWeight {
  file: z.infer<typeof scanFileSchema>
  inspection: Inspection
  sourceIds: Set<string>
}

let inventory = new Map<string, SharedWeight>()
let statuses: ModelSourceStatus[] = []
/** The Moss Studio download folders `statuses` were scanned against; a status is reused only for the same folders. */
let statusesWritable = ''
let ongoing: Promise<void> | null = null
let scanGeneration = 0
let cachedEngine: string | null = null
let inventoryEngine = ''
const inspected = new Map<string, z.infer<typeof cacheEntrySchema>>()

async function loadIndex(engine: string): Promise<void> {
  const file = paths.sharedModelIndex()
  const key = file + '\0' + engine
  if (key === cachedEngine) return
  cachedEngine = key
  inspected.clear()
  if (!engine) return
  const index = await readSharedIndex()
  if (index?.engine === engine) {
    for (const [path, value] of Object.entries(index.files)) inspected.set(path, value)
  }
}

async function readSharedIndex(): Promise<z.infer<typeof indexSchema> | undefined> {
  try {
    const parsed = indexSchema.safeParse(JSON.parse(await readFile(paths.sharedModelIndex(), 'utf8')))
    if (parsed.success) return parsed.data
  } catch {
    // Missing or unreadable cache: the shared files are checked again.
  }
}

function idFor(path: string): string {
  return SHARED_MODEL_PREFIX + createHash('sha256').update(modelPathKey(path)).digest('hex').slice(0, 24)
}

function storageRoots(settings: Settings): string[] {
  return [
    paths.models(settings.modelsRoot),
    ...Object.values(settings.modelDirectories ?? {}).filter((path): path is string => Boolean(path)),
  ]
}

async function managedRoots(settings: Settings): Promise<string[]> {
  return Promise.all(storageRoots(settings).map((path) => realpath(path).catch(() => path)))
}

function writableKey(writable: string[]): string {
  return JSON.stringify(writable.map(modelPathKey))
}

/**
 * Splits a shared root against Moss Studio's download folders: a root inside one is
 * skipped, and a download folder inside a root is left out of its scan. A per-role
 * folder may point into a ComfyUI tree, so both keep working without listing a file twice.
 */
function separateFromDownloads(root: string, writable: string[]): { readable: boolean; exclude: string[] } {
  return {
    readable: !writable.some((target) => isInside(target, root)),
    exclude: writable.filter((target) => isInside(root, target)),
  }
}

/** A cached answer for an unchanged file, or null when the engine must be asked and is not there. Engine errors throw. */
async function inspectWeight(file: ScannedModel, request: EngineRequest | null): Promise<Inspection | string | null> {
  if (file.layout === 'diffusers-folder') {
    const folder = await diffusersFolderProblem(file.path)
    if (typeof folder === 'string') return importProblemText(folder, file.path)
    return { role: 'full', precision: folder.dtype ?? 'local' }
  }
  if (!engineReads(file.path)) return importProblemText('format', file.path)
  const key = modelPathKey(file.path)
  const cached = inspected.get(key)
  if (cached?.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.value
  if (!request) return null
  const result = await request('inspect', { path: file.path })
  // The engine's own answer, also for a GGUF main model it converts on first load.
  const recognition = recognize(result, file.path)
  const value: Inspection | string = recognition.kind
    ? {
        role: recognition.kind,
        precision: recognition.precision ?? 'local',
        base: recognition.baseModel,
        controlKinds: recognition.controlKinds ?? [],
      }
    : importProblemText(recognition.problem ?? 'not-moss', file.path)
  inspected.set(key, { size: file.size, mtimeMs: file.mtimeMs, value })
  return value
}

/** Weight files the engine opens itself: safetensors, and GGUF for a main model. */
export function engineReads(path: string): boolean {
  return ['.safetensors', '.sft', '.gguf'].includes(extname(path).toLowerCase())
}

/**
 * Why a diffusers folder cannot be used as a whole model, or what it is: a
 * MOSS-Image `model_index.json`, not FP16, with its runtime configs.
 */
export async function diffusersFolderProblem(path: string): Promise<ModelImportProblem | { dtype: string | null }> {
  const dir = await inspectDiffusersFolder(path)
  if (!dir) return 'folder-incomplete'
  try {
    const index = JSON.parse(await readFile(join(path, 'model_index.json'), 'utf8')) as { _class_name?: unknown }
    if (typeof index._class_name !== 'string' || !/moss.?image/i.test(index._class_name)) return 'not-moss'
    if (dir.dtype === 'fp16') return 'fp16'
    if (!(await legacyModelReady(path))) return 'folder-incomplete'
    return { dtype: dir.dtype }
  } catch {
    return 'folder-incomplete'
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function sharedEngine(): Promise<{ server: string | null; key: string }> {
  const server = localServerPath()
  const info = server ? await stat(server).catch(() => null) : null
  return { server, key: server && info ? server + ':' + info.mtimeMs : '' }
}

function snapshotKey(sources: ModelSource[], writable: string[]): string {
  const locations = sources.map(({ id, kind, path }) => [id, kind, modelPathKey(path)])
  return createHash('sha256')
    .update(JSON.stringify([locations, writable.map(modelPathKey)]))
    .digest('hex')
}

/**
 * Restores the last inventory so pickers work at once; a file is still checked for
 * its path, size and mtime before use. Returns true when a background refresh is
 * due: the sources or download folders changed, or the engine changed and must
 * check the files again.
 */
export async function restoreModelSources(settings: Settings): Promise<boolean> {
  const sources = settings.modelSources ?? []
  if (!sources.length) return false
  const [index, writable, engine] = await Promise.all([readSharedIndex(), managedRoots(settings), sharedEngine()])
  const snapshot = index?.snapshot
  if (!index || !snapshot) return true
  const same = snapshot.key === snapshotKey(sources, writable)
  // Until the refresh replaces them, the sources still configured keep their old answers, so nothing disappears meanwhile.
  const current = new Set(sources.map((source) => source.id + '\0' + modelPathKey(source.path)))
  statuses = snapshot.statuses.filter((status) => current.has(status.id + '\0' + modelPathKey(status.path)))
  const kept = new Set(statuses.map((status) => status.id))
  inventory = new Map(
    snapshot.weights.flatMap(({ file, inspection, sourceIds }) => {
      const ids = sourceIds.filter((id) => kept.has(id))
      return ids.length ? [[idFor(file.path), { file, inspection, sourceIds: new Set(ids) }] as const] : []
    }),
  )
  statusesWritable = same ? writableKey(writable) : ''
  inventoryEngine = index.engine
  return !same || index.engine !== engine.key
}

async function scanSources(settings: Settings, generation: number, changed: boolean): Promise<void> {
  const sources = settings.modelSources ?? []
  const [writable, { server, key: engineKey }] = await Promise.all([managedRoots(settings), sharedEngine()])
  const unchanged = new Map<string, ModelSourceStatus>()
  if (changed && inventoryEngine === engineKey && statusesWritable === writableKey(writable)) {
    for (const source of sources) {
      const last = statuses.find((status) => status.id === source.id && status.path === source.path && status.kind === source.kind)
      if (last) unchanged.set(source.id, last)
    }
  }
  const roots = await Promise.all(sources.map((source) => (unchanged.has(source.id) ? Promise.resolve(null) : sourceRoots(source))))
  const scans = new Map<string, Awaited<ReturnType<typeof scanModelDirectory>>>()
  await loadIndex(engineKey)
  const next = new Map<string, SharedWeight>()
  for (const [id, weight] of inventory) {
    const sourceIds = new Set([...weight.sourceIds].filter((sourceId) => unchanged.has(sourceId)))
    if (sourceIds.size) next.set(id, { ...weight, sourceIds })
  }
  const nextStatuses: ModelSourceStatus[] = []
  const groups: Array<{ status: ModelSourceStatus; files: Map<string, ScannedModel> }> = []
  for (const [index, source] of sources.entries()) {
    if (generation !== scanGeneration) return
    const kept = unchanged.get(source.id)
    if (kept) {
      nextStatuses.push(kept)
      continue
    }
    const resolved = roots[index]!
    const parts = resolved.roots.map((root) => ({ root, ...separateFromDownloads(root, writable) }))
    const status: ModelSourceStatus = {
      ...source,
      roots: parts.filter((part) => part.readable).map((part) => part.root),
      available: 0,
      pending: 0,
      incompatible: 0,
      files: [],
      issues: [...resolved.issues],
    }
    nextStatuses.push(status)
    if (parts.some((part) => !part.readable || part.exclude.length)) status.issues.push('已跳过与 Moss Studio 下载位置重叠的目录')
    const files = new Map<string, ScannedModel>()
    for (const { root, exclude } of parts.filter((part) => part.readable)) {
      try {
        let scan = scans.get(root)
        if (!scan) {
          scan = await scanModelDirectory(root, { shared: { exclude } })
          scans.set(root, scan)
        }
        const role = resolved.roles.get(root)
        for (const file of scan.candidates) {
          const id = idFor(file.path)
          if (role && file.layout !== 'diffusers-folder') files.set(id, { ...file, role })
          else if (!files.has(id)) files.set(id, file)
        }
        for (const item of scan.skipped) {
          status.issues.push(/已停止|已跳过/.test(item.reason) ? item.reason : '部分文件夹无法读取：' + item.path)
        }
      } catch {
        status.issues.push('读不到模型目录：' + root)
      }
    }
    groups.push({ status, files })
  }

  async function inspectGroups(request: EngineRequest | null): Promise<void> {
    const results = new Map<string, Inspection | string | null>()
    const failures = new Map<string, string>()
    for (const { status, files } of groups) {
      status.available = status.pending = status.incompatible = 0
      status.files = []
      let failure: string | undefined
      for (const [id, file] of files) {
        if (generation !== scanGeneration) return
        if (!results.has(id)) {
          try {
            results.set(id, await inspectWeight(file, request))
          } catch (error) {
            // Left 待检查 so the next 自动扫描 asks again; the reason shows on the source.
            results.set(id, null)
            failures.set(id, errorText(error))
          }
        }
        const result = results.get(id)
        failure ??= failures.get(id)
        const entry: ModelSourceFile = { path: file.path, name: file.name, size: file.size, role: file.role, state: 'pending' }
        if (typeof result === 'string') {
          entry.state = 'incompatible'
          entry.reason = result
        } else if (result) {
          entry.state = 'available'
          entry.role = result.role
          const { path, name, size, mtimeMs, layout } = file
          const sourceIds = next.get(id)?.sourceIds ?? new Set<string>()
          sourceIds.add(status.id)
          next.set(id, { file: { path, name, size, mtimeMs, layout }, inspection: result, sourceIds })
        }
        status[entry.state]++
        status.files.push(entry)
      }
      if (failure) status.issues.push('引擎没能检查部分文件，下次自动扫描会重试：' + failure)
    }
  }

  if (generation !== scanGeneration) return
  const needsEngine = groups.some(({ files }) =>
    [...files.values()].some((file) => {
      const cached = inspected.get(modelPathKey(file.path))
      return file.layout !== 'diffusers-folder' && engineReads(file.path) && (cached?.size !== file.size || cached.mtimeMs !== file.mtimeMs)
    }),
  )
  if (engineKey && server && needsEngine) {
    try {
      await withEngineRequests(server, inspectGroups)
    } catch (error) {
      console.warn('[model-sources] engine inspect failed', error)
      await inspectGroups(null)
      for (const { status } of groups) {
        if (status.pending) status.issues.push('引擎没能检查部分文件，下次自动扫描会重试：' + errorText(error))
      }
    }
  } else {
    await inspectGroups(null)
    if (needsEngine) {
      for (const { status } of groups) if (status.pending) status.issues.push('还没有安装引擎，装好后点击「自动扫描」检查这些文件')
    }
  }
  if (generation !== scanGeneration) return
  inventory = next
  inventoryEngine = engineKey
  statuses = nextStatuses
  statusesWritable = writableKey(writable)
  const currentKeys = new Set(nextStatuses.flatMap((source) => source.files.map((file) => modelPathKey(file.path))))
  for (const key of inspected.keys()) if (!currentKeys.has(key)) inspected.delete(key)
  try {
    await mkdir(paths.cache(), { recursive: true })
    await writeFileAtomic(
      paths.sharedModelIndex(),
      JSON.stringify({
        engine: engineKey,
        files: Object.fromEntries(inspected),
        snapshot: {
          key: snapshotKey(sources, writable),
          statuses: nextStatuses,
          weights: [...next.values()].map((weight) => ({ ...weight, sourceIds: [...weight.sourceIds] })),
        },
      }),
    )
  } catch (error) {
    console.warn('[model-sources] could not save the shared model index', error)
  }
}

/**
 * Scans the shared sources once however many windows ask. `changed` means the
 * sources or the download folders changed: a scan already running is dropped and
 * the latest settings are scanned instead.
 */
export async function refreshModelSources(settings: Settings, changed = false): Promise<void> {
  if (changed) {
    const generation = ++scanGeneration
    const active = new Set((settings.modelSources ?? []).map((source) => source.id))
    const previousPaths = new Map(statuses.map((source) => [source.id, source.path]))
    for (const source of settings.modelSources ?? []) if (previousPaths.get(source.id) !== source.path) active.delete(source.id)
    inventory = new Map([...inventory].filter(([, value]) => [...value.sourceIds].some((id) => active.has(id))))
    if (ongoing) await ongoing
    if (generation !== scanGeneration) return
    settings = getSettings()
  } else if (ongoing) return ongoing
  if (!(settings.modelSources?.length || statuses.length || inventory.size)) return
  const run = scanSources(settings, scanGeneration, changed)
  ongoing = run
  try {
    await run
  } finally {
    if (ongoing === run) ongoing = null
  }
}

let discoveryTask: { force: boolean; promise: ReturnType<typeof nearbyModelSources> } | null = null

async function discoverModelSources(force: boolean): Promise<Awaited<ReturnType<typeof nearbyModelSources>>> {
  const current = discoveryTask
  if (current) {
    if (!force || current.force) return current.promise
    await current.promise
    return discoverModelSources(true)
  }
  const cacheFile = paths.modelSourceDiscovery()
  const task = (async () => {
    if (!force) {
      try {
        const parsed = discoverySchema.safeParse(JSON.parse(await readFile(cacheFile, 'utf8')))
        if (parsed.success) return parsed.data
      } catch {
        // First open or a damaged cache: discover once.
      }
    }
    const discovery = await nearbyModelSources(force)
    try {
      await mkdir(paths.cache(), { recursive: true })
      // Running services show only for the scan that found them, so they are not cached.
      await writeFileAtomic(cacheFile, JSON.stringify({ sources: discovery.sources }))
    } catch (error) {
      console.warn('[model-sources] could not save the discovery cache', error)
    }
    return discovery
  })()
  discoveryTask = { force, promise: task }
  try {
    return await task
  } finally {
    if (discoveryTask?.promise === task) discoveryTask = null
  }
}

export async function modelSourcesView(settings: Settings, mode: 'cached' | 'connected' | 'scan' = 'cached'): Promise<ModelSourcesView> {
  const sources = settings.modelSources ?? []
  const paths = new Set(sources.map((source) => modelPathKey(source.path)))
  const discovery = mode === 'connected' ? { sources: [] } : await discoverModelSources(mode === 'scan')
  return {
    sources: sources.map(
      (source) =>
        statuses.find((status) => status.id === source.id && status.path === source.path) ?? {
          ...source,
          roots: [],
          available: 0,
          pending: 0,
          incompatible: 0,
          files: [],
          issues: [],
        },
    ),
    services: discovery.services,
    suggestions: discovery.sources
      .filter((source) => !paths.has(modelPathKey(source.path)))
      .map((source) => ({ ...source, id: idFor(source.path) })),
  }
}

/**
 * Adds a source, or with `id` moves one to a new path. `picked` is set only for a
 * folder chosen in the folder dialog: only that may be on the network.
 */
export async function addModelSource(
  path: string,
  kind?: ModelSource['kind'],
  id?: string,
  { picked = false }: { picked?: boolean } = {},
): Promise<Settings> {
  if (isNetworkPath(path) && !picked) throw new Error('网络位置请用「添加来源」选择文件夹')
  const actual = await realpath(path).catch(() => null)
  if (!actual) throw new Error('找不到此位置，请重新选择')
  if (isNetworkPath(actual) && !picked) throw new Error('网络位置请用「添加来源」选择文件夹')
  if (isTooBroadModelFolder(actual)) throw new Error('请选择具体的模型目录，不要选整个磁盘或用户主目录')
  const sourceKind = kind ?? (await guessModelSourceKind(actual))
  const existing = getSettings().modelSources ?? []
  const source = { id: id ?? randomUUID(), kind: sourceKind, path: actual }
  if (id && !existing.some((entry) => entry.id === id)) throw new Error('找不到要更换的共享目录')
  if (existing.some((entry) => entry.id !== id && modelPathKey(entry.path) === modelPathKey(actual))) {
    if (id) throw new Error('这个位置已经接入')
    return getSettings()
  }
  const modelSources = id ? existing.map((entry) => (entry.id === id ? source : entry)) : [...existing, source]
  // Another window may have changed the sources while the kind was guessed; the newest settings win.
  const current = getSettings().modelSources ?? []
  if (current !== existing && (current.length || existing.length)) throw new Error('共享目录已更新，请刷新后重试')
  return updateSettings({ modelSources })
}

export function removeModelSource(id: string): Settings {
  return updateSettings({ modelSources: (getSettings().modelSources ?? []).filter((source) => source.id !== id) })
}

type SharedWeightCheck = { path: string } | { problem: 'missing' | 'changed' }

async function checkSharedWeight(id: string): Promise<SharedWeightCheck> {
  const entry = inventory.get(id)
  if (!entry) return { problem: 'missing' }
  const { file } = entry
  try {
    // A path that now resolves elsewhere (a re-pointed link) is a different file than the one checked.
    if (modelPathKey(await realpath(file.path)) !== modelPathKey(file.path)) return { problem: 'changed' }
    if (file.layout === 'diffusers-folder') {
      const current = await inspectDiffusersFolder(file.path)
      if (!current) return { problem: 'missing' }
      return current.size === file.size && current.mtimeMs === file.mtimeMs ? { path: file.path } : { problem: 'changed' }
    }
    const current = await stat(file.path)
    return current.isFile() && current.size === file.size && current.mtimeMs === file.mtimeMs ? { path: file.path } : { problem: 'changed' }
  } catch {
    return { problem: 'missing' }
  }
}

/** The shared file or folder as it was checked, or null when it is gone or changed since. */
export async function resolveSharedWeight(id: string): Promise<string | null> {
  const check = await checkSharedWeight(id)
  return 'path' in check ? check.path : null
}

/** Like `resolveSharedWeight`, but a job gets a message saying whether the file is gone or changed. */
export async function requireSharedWeight(id: string, name: string): Promise<string> {
  const check = await checkSharedWeight(id)
  if ('path' in check) return check.path
  throw new Error(
    check.problem === 'changed'
      ? `「${name}」的文件改动过，请到「模型」页点「自动扫描」后再试`
      : `找不到「${name}」的文件，请检查磁盘是否连接，再到「模型」页点「自动扫描」`,
  )
}

const SHARED_NOTES = '共享模型目录里的文件，在原位置使用，不复制也不移动。'

/** Shared weights as catalog entries. Kept even when the same file is also registered, so both ids resolve. */
export function sharedModels(): ModelEntry[] {
  return [...inventory].flatMap(([id, { file, inspection }]) => {
    if (inspection.role === 'lora' || inspection.role === 'control_adapter') return []
    return [
      {
        id,
        name: file.name,
        role: inspection.role,
        repo: file.path,
        provider: 'local',
        localPath: file.path,
        revision: 'local',
        family: 'moss-image',
        precision: inspection.precision,
        format: file.layout === 'diffusers-folder' ? 'diffusers' : 'comfyui',
        files: [basename(file.path)],
        license: 'local',
        tags: ['shared-directory'],
        notes: SHARED_NOTES,
        sizeBytes: file.size,
        installedBytes: file.size,
        installed: true,
        installState: 'ready',
      },
    ]
  })
}

export function sharedAdapters(): AdapterEntry[] {
  return [...inventory].flatMap(([id, { file, inspection }]) =>
    inspection.role === 'lora'
      ? [
          {
            id,
            name: file.name,
            provider: 'local',
            repo: file.path,
            revision: 'local',
            kind: 'lora',
            base: inspection.base,
            license: 'local',
            files: [basename(file.path)],
            sizeBytes: file.size,
            installedBytes: file.size,
            tags: ['shared-directory'],
            notes: SHARED_NOTES,
            installed: true,
          },
        ]
      : [],
  )
}

export function sharedControlAdapters(): ControlAdapterEntry[] {
  return [...inventory].flatMap(([id, { file, inspection }]) =>
    inspection.role === 'control_adapter'
      ? [
          {
            id,
            name: file.name,
            path: file.path,
            sizeBytes: file.size,
            controlKinds: inspection.controlKinds ?? [],
            baseModel: inspection.base,
            addedAt: new Date(file.mtimeMs).toISOString(),
          },
        ]
      : [],
  )
}
