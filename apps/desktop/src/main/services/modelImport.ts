import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Events } from '@shared/channels'
import { RUNTIME_CONFIG_ID, SLOT_LABEL, SLOT_ROLE, SLOTS } from '@shared/modelCombos'
import {
  assembleImport,
  catalogFileMatch,
  int8Instead,
  isModelFileName,
  recognize,
  type ImportedPart,
  type InspectReport,
  type Recognition,
} from '@shared/modelImport'
import { isSharedModelId } from '@shared/sharedModels'
import type { Catalog, ModelEntry, ModelImportFile, ModelImportState, Settings } from '@shared/types'
import { codedError } from '../lib/codedError'
import { emit } from '../lib/events'
import { isNetworkPath, modelPathKey } from '../lib/localPath'
import { paths } from '../lib/paths'
import { withEngineRequests, type EngineRequest } from '../lib/probeEngine'
import { registerControlAdapter } from './controlAdapters'
import { deviceEngines, deviceRunsCli, localServerPath } from './engineInstalls'
import { deleteCombination, listCombinations, saveCombination } from './modelCombinations'
import { inspectDiffusersFolder, relocateImportedModel, removeImportedModel } from './modelImports'
import { getCatalog, installBundle, invalidateCatalog, linkAdapterFile, registerScannedModels } from './models'
import { scanModelDirectory } from './modelScan'
import { addModelSource, diffusersFolderProblem } from './modelSources'
import { installationKind, isTooBroadModelFolder } from './modelSourcePaths'
import { getSettings } from './settings'

/**
 * 导入模型: files and folders the person drops on the window or picks. Every
 * weight file goes through the engine's `inspect` (header only, no GPU), two at
 * a time through one sidecar, and is used where it is: a model part is
 * registered (standing in for the catalog part it is, by name and exact size),
 * a LoRA or control adapter joins its list, another app's install becomes a
 * shared model folder. Then the main-model parts become whole models
 * (`assembleImport`). One import runs at a time; files added meanwhile join it.
 */

/** The engine runs two `inspect`s at a time and answers `busy` to a third. */
const INSPECT_CONCURRENCY = 2

interface Work {
  file: ModelImportFile
  mtimeMs: number
  folder: boolean
}

let current: ModelImportState | null = null
let work = new Map<string, Work>()
let parts: ImportedPart[] = []
let running: Promise<void> | null = null
/** The registrations of recognised files, in turn: each one reads and rewrites a list on disk. */
let registering: Promise<void> = Promise.resolve()
/** `inspect` answers per engine and file version: the answer depends only on the file and the engine build. */
const answers = new Map<string, InspectReport>()

export interface ImportHooks {
  /** A folder was another app's install and is now a shared model folder: scan it. */
  onSourceAdded?: (settings: Settings) => Promise<void> | void
}

function snapshot(): ModelImportState | null {
  return current ? structuredClone(current) : null
}

function publish(): void {
  if (current) emit(Events.modelImport, snapshot())
}

/** The import running or the last one, as the renderer shows it. */
export function modelImportState(): ModelImportState | null {
  return snapshot()
}

/** Starts an import, or adds these files to the one running. `picked`: chosen in the dialog, so a network place is allowed. */
export async function startModelImport(
  inputs: string[],
  { picked = false, hooks = {} }: { picked?: boolean; hooks?: ImportHooks } = {},
): Promise<ModelImportState> {
  const found = (await Promise.all(inputs.map((input) => expand(input, picked, hooks)))).flat()
  if (!current || current.phase === 'done') {
    current = { id: randomUUID(), phase: 'checking', files: [], models: [], choose: null }
    work = new Map()
    parts = []
  }
  for (const item of found) {
    const key = modelPathKey(item.file.path)
    if (work.has(key)) continue
    work.set(key, item)
    current.files.push(item.file)
  }
  current.phase = 'checking'
  publish()
  void run()
  return snapshot()!
}

/** Picks the check up again once an engine is installed. */
export function resumeModelImport(): void {
  if (current?.phase === 'waiting-engine') void run()
}

/** The last part of a path, also of a Windows share path read on another system. */
const nameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function row(path: string, extra: Partial<ModelImportFile>): Work {
  return { file: { path, name: nameOf(path), sizeBytes: 0, state: 'done', ...extra }, mtimeMs: 0, folder: false }
}

/** What a dropped or picked path holds: one file, a model folder, another app's install, or the model files in a folder. */
async function expand(input: string, picked: boolean, hooks: ImportHooks): Promise<Work[]> {
  // Opening a share on Windows authenticates with the person's account: only a picked place may be one.
  if (isNetworkPath(input) && !picked) return [row(input, { kind: 'unusable', problem: 'network' })]
  const path = await realpath(input).catch(() => null)
  const info = path ? await stat(path).catch(() => null) : null
  if (!path || !info) return [row(input, { kind: 'unusable', problem: 'unreadable' })]
  if (isNetworkPath(path) && !picked) return [row(input, { kind: 'unusable', problem: 'network' })]
  if (info.isFile()) {
    if (!isModelFileName(path)) return [row(path, { kind: 'unusable', problem: 'not-model', sizeBytes: info.size })]
    return [{ file: { path, name: basename(path), sizeBytes: info.size, state: 'checking' }, mtimeMs: info.mtimeMs, folder: false }]
  }
  if (!info.isDirectory()) return [row(path, { kind: 'unusable', problem: 'unreadable' })]
  if (isTooBroadModelFolder(path)) return [row(path, { kind: 'unusable', problem: 'too-broad' })]
  const app = await installationKind(/^models$/i.test(basename(path)) ? dirname(path) : path)
  if (app) {
    const settings = await addModelSource(path, app, undefined, { picked })
    await hooks.onSourceAdded?.(settings)
    return [row(path, { kind: 'source', app })]
  }
  const folder = await inspectDiffusersFolder(path)
  if (folder)
    return [{ file: { path, name: basename(path), sizeBytes: folder.size, state: 'checking' }, mtimeMs: folder.mtimeMs, folder: true }]
  const scan = await scanModelDirectory(path)
  const items = scan.candidates
    .filter((candidate) => candidate.layout === 'diffusers-folder' || isModelFileName(candidate.path))
    .map((candidate): Work => ({
      file: { path: candidate.path, name: candidate.name, sizeBytes: candidate.size, state: 'checking' },
      mtimeMs: candidate.mtimeMs,
      folder: candidate.layout === 'diffusers-folder',
    }))
  return items.length ? items : [row(path, { kind: 'unusable', problem: 'empty-folder' })]
}

function run(): Promise<void> {
  running ??= recognizeAll().finally(() => {
    running = null
  })
  return running
}

/** A computer whose GPUs run only 兼容模式 / AMD 原生: no engine to ask, and no single file loads there. */
function cliOnly(): boolean {
  return deviceEngines().some(({ gpu, engine }) => engine && deviceRunsCli(gpu.id))
}

async function recognizeAll(): Promise<void> {
  while (current) {
    const todo = [...work.values()].filter((item) => item.file.state !== 'done')
    if (!todo.length) break
    const catalog = await getCatalog(getSettings())
    for (const item of todo.filter((entry) => entry.folder)) {
      await useFolder(item, catalog)
      publish()
    }
    const weights = todo.filter((item) => !item.folder)
    if (!weights.length) continue
    const server = localServerPath()
    if (!server) {
      if (cliOnly()) {
        for (const item of weights) Object.assign(item.file, { state: 'done', kind: 'unusable', problem: 'cli' })
        publish()
        continue
      }
      for (const item of weights) item.file.state = 'waiting'
      current.phase = 'waiting-engine'
      publish()
      return
    }
    current.phase = 'checking'
    for (const item of weights) item.file.state = 'checking'
    publish()
    const engineKey = server + ':' + ((await stat(server).catch(() => null))?.mtimeMs ?? 0)
    try {
      await withEngineRequests(server, async (request) => {
        const queue = [...weights]
        const worker = async (): Promise<void> => {
          for (let item = queue.shift(); item; item = queue.shift()) await checkFile(item, request, engineKey, catalog)
        }
        await Promise.all(Array.from({ length: INSPECT_CONCURRENCY }, worker))
      })
    } catch (error) {
      console.warn('[model-import] the engine could not check the files', error)
      for (const item of weights) {
        if (item.file.state !== 'done') Object.assign(item.file, { state: 'done', kind: 'unusable', problem: 'check-failed' })
      }
    }
  }
  if (current) await finish()
}

async function checkFile(item: Work, request: EngineRequest, engineKey: string, catalog: Catalog): Promise<void> {
  const key = [engineKey, modelPathKey(item.file.path), item.file.sizeBytes, item.mtimeMs].join('\0')
  try {
    let report = answers.get(key)
    if (!report) {
      report = await request('inspect', { path: item.file.path })
      answers.set(key, report)
    }
    const recognition = recognize(report, item.file.name)
    // Two answers can arrive together; the lists they go into are read, changed and written one at a time.
    const step = registering.then(() => useWeights(item.file, recognition, catalog))
    registering = step.catch(() => undefined)
    await step
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    Object.assign(item.file, { state: 'done', kind: 'unusable', problem: /^io\b/.test(message) ? 'unreadable' : 'check-failed' })
  }
  publish()
}

/** Puts a recognised file where it belongs, used where it is. */
async function useWeights(file: ModelImportFile, recognition: Recognition, catalog: Catalog): Promise<void> {
  const settings = getSettings()
  file.state = 'done'
  if (!recognition.kind) {
    file.kind = 'unusable'
    file.problem = recognition.problem
    if (recognition.problem === 'fp16' || recognition.problem === 'fp8') offerInt8(file, catalog)
    return
  }
  if (recognition.kind === 'lora') {
    const entry = await linkAdapterFile(settings, { path: file.path, base: recognition.baseModel })
    Object.assign(file, { kind: 'lora', entryId: entry.id })
    return
  }
  if (recognition.kind === 'control_adapter') {
    const entry = registerControlAdapter({
      path: file.path,
      controlKinds: recognition.controlKinds ?? [],
      baseModel: recognition.baseModel,
    })
    Object.assign(file, { kind: 'control', entryId: entry.id })
    return
  }
  const match = catalogFileMatch(file, catalog.models, recognition.kind)
  const registered = await registerScannedModels(settings, [
    {
      path: file.path,
      role: recognition.kind,
      name: file.name,
      layout: 'comfyui-single-file',
      inspected: true,
      ...(recognition.precision ? { precision: recognition.precision } : {}),
      ...(match ? { catalogId: match.id } : {}),
    },
  ])
  const id = match?.id ?? registered.ids[0]
  if (!id) {
    Object.assign(file, { kind: 'unusable', problem: 'unreadable' })
    return
  }
  Object.assign(file, {
    kind: 'part',
    role: recognition.kind,
    entryId: id,
    ...(recognition.precision ? { precision: recognition.precision } : {}),
    ...(recognition.converts ? { converts: true } : {}),
    ...(match ? { catalogName: match.choice ?? match.name } : {}),
  })
  parts.push({ id, role: recognition.kind, name: file.name, precision: recognition.precision, catalogId: match?.id })
}

/** A version the engine cannot read: the INT8 single-file model of the same flavour is the way out, while it is not here. */
function offerInt8(file: ModelImportFile, catalog: Catalog): void {
  const bundle = int8Instead(file.name, catalog.bundles, catalog.models)
  const needs = bundle ? [...Object.values(bundle.components), bundle.support] : []
  if (bundle && !needs.every((id) => catalog.models.find((model) => model.id === id)?.installed)) {
    file.offer = { bundleId: bundle.id, label: '下载 INT8 版' }
  }
}

/** A diffusers folder: read by the app itself, then used in place for the catalog model it is. */
async function useFolder(item: Work, catalog: Catalog): Promise<void> {
  const { file } = item
  file.state = 'done'
  const folder = await diffusersFolderProblem(file.path)
  if (typeof folder === 'string') {
    Object.assign(file, { kind: 'unusable', problem: folder })
    if (folder === 'fp16') offerInt8(file, catalog)
    return
  }
  const settings = getSettings()
  await registerScannedModels(settings, [{ path: file.path, role: 'full', layout: 'diffusers-folder' }])
  const after = await getCatalog(settings, true)
  const served = after.bundles.filter(
    (bundle) =>
      !bundle.custom &&
      [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae].every((id) => {
        const model = after.models.find((entry) => entry.id === id)
        return model?.installed && model.localPath === file.path
      }),
  )
  Object.assign(file, { kind: served.length ? 'model' : 'part', role: 'full', ...(folder.dtype ? { precision: folder.dtype } : {}) })
  for (const bundle of served) current?.models.push({ bundleId: bundle.id, name: bundle.name })
}

const sameParts = (a: { dit: string; textEncoder: string; vae: string }, b: { dit: string; textEncoder: string; vae: string }): boolean =>
  a.dit === b.dit && a.textEncoder === b.textEncoder && a.vae === b.vae

async function finish(): Promise<void> {
  if (!current) return
  const settings = getSettings()
  const catalog = await getCatalog(settings, true)
  const assembly = assembleImport(parts, catalog.bundles, catalog.models)
  for (const step of assembly.steps) {
    if (step.kind === 'bundle') {
      const bundle = catalog.bundles.find((item) => item.id === step.bundleId)
      if (bundle && !current.models.some((model) => model.bundleId === bundle.id))
        current.models.push({ bundleId: bundle.id, name: bundle.name })
      continue
    }
    // Importing the same files again finds the model they already make.
    const combination =
      listCombinations().find((entry) => sameParts(entry.components, step.components)) ??
      saveCombination({ name: step.name, components: step.components })
    if (!current.models.some((model) => model.bundleId === combination.id)) {
      current.models.push({ bundleId: combination.id, name: combination.name })
    }
  }
  current.choose = assembly.choose
  invalidateCatalog()
  // Single files load next to the 20 MB runtime config; when nothing else is missing it comes without asking.
  const after = await getCatalog(settings, true)
  for (const { bundleId } of current.models) {
    const bundle = after.bundles.find((item) => item.id === bundleId)
    const missing = bundle
      ? [...Object.values(bundle.components), bundle.support].filter((id) => !after.models.find((model) => model.id === id)?.installed)
      : []
    if (bundle && missing.length === 1 && missing[0] === RUNTIME_CONFIG_ID) {
      await installBundle(bundle.id, settings).catch((error: unknown) => console.warn('[model-import] runtime config', error))
    }
  }
  current.phase = 'done'
  publish()
  emit(Events.modelsChanged, { reason: 'import' })
}

/* ------------------------------------------------------------------ */
/* 重新找到… and 移除 for a model whose own files moved                   */
/* ------------------------------------------------------------------ */

const isOwnFile = (model: ModelEntry): boolean => model.provider === 'local' || model.tags.includes('local-file')

function importIndex(settings: Settings): string {
  return join(paths.modelImports(settings.modelsRoot), 'index.json')
}

/** Asks the engine what one file is; null when there is no engine to ask. */
async function inspectOne(path: string): Promise<Recognition | null> {
  const server = localServerPath()
  if (!server) return null
  return recognize(await withEngineRequests(server, (request) => request('inspect', { path })), path)
}

/**
 * 重新找到…: for each own part of the model that is not where it was, the person
 * picks the file; the engine has to call it the same kind of part. The
 * registration keeps its id, so combinations and 画面 that use it keep working.
 */
export async function relocateBundle(
  bundleId: string,
  pick: (title: string, near: string | undefined) => Promise<string | null>,
): Promise<{ found: number }> {
  const settings = getSettings()
  const catalog = await getCatalog(settings, true)
  const bundle = catalog.bundles.find((item) => item.id === bundleId)
  if (!bundle) throw codedError('E_NOT_FOUND', '这个模型已经不在了')
  let found = 0
  for (const slot of SLOTS) {
    const id = bundle.components[slot]
    const model = catalog.models.find((entry) => entry.id === id)
    const lost = model ? !model.installed && isOwnFile(model) && !isSharedModelId(model.id) : isSharedModelId(id)
    if (!lost) continue
    const path = await pick(`重新找到「${model?.name ?? SLOT_LABEL[slot]}」`, model?.localPath ? dirname(model.localPath) : undefined)
    if (!path) break
    const recognition = await inspectOne(path)
    if (recognition && recognition.kind !== SLOT_ROLE[slot]) {
      throw codedError('E_WRONG_FILE', `这个文件不是${SLOT_LABEL[slot]}，请选原来那个文件`)
    }
    if (model) {
      await relocateImportedModel(importIndex(settings), id, path)
    } else if (bundle.custom) {
      // A shared folder's file that is gone has no record left: the picked file is added and takes its place.
      const registered = await registerScannedModels(settings, [
        {
          path,
          role: SLOT_ROLE[slot] as 'dit' | 'text_encoder' | 'vae',
          layout: 'comfyui-single-file',
          precision: recognition?.precision,
          inspected: Boolean(recognition),
        },
      ])
      const added = registered.ids[0]
      if (!added) throw codedError('E_INPUT_PATH', '找不到这个文件，请重新选择')
      saveCombination({ id: bundle.id, name: bundle.name, components: { ...bundle.components, [slot]: added } })
    }
    found += 1
  }
  invalidateCatalog()
  emit(Events.modelsChanged, { reason: 'relocate', id: bundleId })
  return { found }
}

/** 移除: drops the model's own files that are gone (the files stay wherever they are), and the combination when it is one. */
export async function forgetBundle(bundleId: string): Promise<{ ok: true }> {
  const settings = getSettings()
  const catalog = await getCatalog(settings, true)
  const bundle = catalog.bundles.find((item) => item.id === bundleId)
  if (!bundle) return { ok: true }
  for (const id of Object.values(bundle.components)) {
    const model = catalog.models.find((entry) => entry.id === id)
    if (model && !model.installed && isOwnFile(model) && !isSharedModelId(id)) {
      // A record already gone from the list leaves nothing to remove.
      await removeImportedModel(importIndex(settings), id).catch(() => undefined)
    }
  }
  if (bundle.custom && listCombinations().some((entry) => entry.id === bundleId)) deleteCombination(bundleId)
  invalidateCatalog()
  emit(Events.modelsChanged, { reason: 'forget', id: bundleId })
  return { ok: true }
}
