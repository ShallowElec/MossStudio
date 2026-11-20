/**
 * 导入模型 in the mock main process: what the engine's `inspect` says each
 * path is comes from `state.importFiles`, and the rest is what main does with
 * the answer: a catalog part's own copy stands in for it, other parts become
 * own entries, LoRA and control adapters join their lists, and the parts are
 * made into whole models with the real `assembleImport`.
 */
import { Events, Ipc } from '@shared/channels'
import { RUNTIME_CONFIG_ID, combinationBundle } from '@shared/modelCombos'
import { assembleImport, isOwnFile, type ImportedPart } from '@shared/modelImport'
import type { ModelEntry, ModelImportFile, ModelImportKind, ModelImportState, ModelSourceKind } from '@shared/types'
import { controlAdapterFixture, downloadFixture } from './fixtures'
import type { MockBackendState } from './scenarios'

/** The engine's verdict on one path, as main records it. */
export interface MockImportFile {
  sizeBytes: number
  kind: ModelImportKind
  role?: 'dit' | 'text_encoder' | 'vae'
  precision?: string
  /** The catalog part this file is by name and size. */
  catalogId?: string
  problem?: ModelImportFile['problem']
  /** The INT8 model offered instead of an unreadable version. */
  offerBundleId?: string
  /** A model folder: the catalog model it stands in for. */
  bundleId?: string
  app?: ModelSourceKind
  converts?: boolean
}

type Emit = (event: string, data: unknown) => void
type Set = (channel: string, handler: (payload: unknown, context: { state: MockBackendState; emit: Emit }) => unknown) => void

const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

function check(state: MockBackendState, file: ModelImportFile, parts: ImportedPart[]): void {
  const verdict = state.importFiles[file.path]
  file.state = 'done'
  if (!verdict) {
    Object.assign(file, { kind: 'unusable', problem: 'not-model' })
    return
  }
  file.sizeBytes = verdict.sizeBytes
  const catalog = state.catalog
  switch (verdict.kind) {
    case 'unusable':
      Object.assign(file, {
        kind: 'unusable',
        problem: verdict.problem ?? 'not-moss',
        ...(verdict.offerBundleId ? { offer: { bundleId: verdict.offerBundleId, label: '下载 INT8 版' } } : {}),
      })
      return
    case 'source':
      Object.assign(file, { kind: 'source', app: verdict.app ?? 'comfyui' })
      return
    case 'lora': {
      const id = `lora-${catalog.adapters.length + 1}`
      state.catalog = {
        ...catalog,
        adapters: [
          ...catalog.adapters,
          {
            id,
            name: nameOf(file.path).replace(/\.[^.]+$/, ''),
            provider: 'local',
            repo: file.path,
            revision: 'local',
            kind: 'lora',
            license: 'local',
            files: [nameOf(file.path)],
            sizeBytes: verdict.sizeBytes,
            installedBytes: verdict.sizeBytes,
            tags: ['local-file'],
            notes: '在原位置使用，不复制也不移动。',
            installed: true,
          },
        ],
      }
      Object.assign(file, { kind: 'lora', entryId: id })
      return
    }
    case 'control': {
      const entry = controlAdapterFixture({ id: `control-${state.controlAdapters.length + 1}`, name: nameOf(file.path), path: file.path })
      state.controlAdapters = [...state.controlAdapters, entry]
      Object.assign(file, { kind: 'control', entryId: entry.id })
      return
    }
    case 'model': {
      const bundle = catalog.bundles.find((item) => item.id === verdict.bundleId)
      const ids = new Set(bundle ? [...Object.values(bundle.components), bundle.support] : [])
      state.catalog = {
        ...catalog,
        models: catalog.models.map((model) =>
          ids.has(model.id)
            ? {
                ...model,
                installed: true,
                installState: 'ready',
                installedBytes: model.sizeBytes,
                localPath: file.path,
                tags: [...model.tags, 'local-folder'],
              }
            : model,
        ),
      }
      Object.assign(file, { kind: 'model', role: 'full' })
      if (bundle) state.modelImport?.models.push({ bundleId: bundle.id, name: bundle.name })
      return
    }
    case 'part': {
      const role = verdict.role ?? 'dit'
      let id: string
      if (verdict.catalogId) {
        id = verdict.catalogId
        state.catalog = {
          ...catalog,
          models: catalog.models.map((model) =>
            model.id === id
              ? {
                  ...model,
                  installed: true,
                  installState: 'ready',
                  installedBytes: model.sizeBytes,
                  localPath: file.path,
                  tags: [...model.tags, 'local-file'],
                }
              : model,
          ),
        }
      } else {
        id = `local-scan-${catalog.models.filter((model) => model.provider === 'local').length}`
        const entry: ModelEntry = {
          id,
          name: nameOf(file.path),
          provider: 'local',
          repo: file.path,
          revision: 'local',
          role,
          format: 'comfyui',
          family: 'local',
          precision: verdict.precision ?? 'bf16',
          license: 'local',
          tags: ['local-import', 'comfyui', 'unhashed', 'engine-checked'],
          localPath: file.path,
          installState: 'ready',
          installed: true,
          installedBytes: verdict.sizeBytes,
          sizeBytes: verdict.sizeBytes,
        }
        state.catalog = { ...catalog, models: [...catalog.models, entry] }
      }
      const match = verdict.catalogId ? state.catalog.models.find((model) => model.id === verdict.catalogId) : undefined
      Object.assign(file, {
        kind: 'part',
        role,
        entryId: id,
        ...(verdict.precision ? { precision: verdict.precision } : {}),
        ...(verdict.converts ? { converts: true } : {}),
        ...(match ? { catalogName: match.choice ?? match.name } : {}),
      })
      parts.push({ id, role, name: nameOf(file.path), precision: verdict.precision, catalogId: verdict.catalogId })
    }
  }
}

/** Ends the import: every file checked, the parts made into models, the 20 MB runtime config fetched when it is all that is missing. */
export function finishModelImport(state: MockBackendState, emit: Emit): void {
  const current = state.modelImport
  if (!current) return
  const parts: ImportedPart[] = []
  for (const file of current.files) if (file.state !== 'done') check(state, file, parts)
  const assembly = assembleImport(parts, state.catalog.bundles, state.catalog.models)
  for (const step of assembly.steps) {
    if (step.kind === 'bundle') {
      const bundle = state.catalog.bundles.find((item) => item.id === step.bundleId)
      if (bundle) current.models.push({ bundleId: bundle.id, name: bundle.name })
      continue
    }
    const id = `combo-import-${state.catalog.bundles.filter((bundle) => bundle.custom).length + 1}`
    const bundle = combinationBundle(
      { id, name: step.name, components: step.components, createdAt: new Date(0).toISOString() },
      state.catalog.models,
    )
    state.catalog = { ...state.catalog, bundles: [...state.catalog.bundles, bundle] }
    current.models.push({ bundleId: id, name: step.name })
  }
  current.choose = assembly.choose
  for (const { bundleId } of current.models) {
    const bundle = state.catalog.bundles.find((item) => item.id === bundleId)
    const missing = bundle
      ? [...Object.values(bundle.components), bundle.support].filter(
          (id) => !state.catalog.models.find((model) => model.id === id)?.installed,
        )
      : []
    if (missing.length === 1 && missing[0] === RUNTIME_CONFIG_ID && !state.downloads.some((task) => task.targetId === RUNTIME_CONFIG_ID)) {
      const config = state.catalog.models.find((model) => model.id === RUNTIME_CONFIG_ID)!
      state.downloads = [
        ...state.downloads,
        downloadFixture({
          id: `model:${RUNTIME_CONFIG_ID}`,
          kind: 'model',
          targetId: RUNTIME_CONFIG_ID,
          label: config.name,
          totalBytes: config.sizeBytes,
        }),
      ]
    }
  }
  current.phase = 'done'
  emit(Events.modelImport, structuredClone(current))
  emit(Events.modelsChanged, { reason: 'import' })
}

function startImport(state: MockBackendState, emit: Emit, paths: string[]): ModelImportState {
  if (!state.modelImport || state.modelImport.phase === 'done') {
    state.modelImport = { id: `import-${Date.now()}`, phase: 'checking', files: [], models: [], choose: null }
  }
  const current = state.modelImport
  for (const path of paths) {
    if (current.files.some((file) => file.path === path)) continue
    current.files.push({ path, name: nameOf(path), sizeBytes: state.importFiles[path]?.sizeBytes ?? 0, state: 'checking' })
  }
  current.phase = 'checking'
  if (state.engineReadiness.state !== 'ready') {
    // As main: a model folder or another app's install is read without the engine; weight files wait for one.
    const parts: ImportedPart[] = []
    for (const file of current.files) {
      if (file.state === 'done') continue
      const kind = state.importFiles[file.path]?.kind
      if (kind === 'model' || kind === 'source') check(state, file, parts)
      else file.state = 'waiting'
    }
    if (current.files.some((file) => file.state === 'waiting')) current.phase = 'waiting-engine'
    else finishModelImport(state, emit)
  } else if (!state.importHold) finishModelImport(state, emit)
  emit(Events.modelImport, structuredClone(current))
  return structuredClone(current)
}

export function addModelImportHandlers(set: Set): void {
  set(Ipc.modelsImport, (payload, { state, emit }) => startImport(state, emit, (payload as { paths: string[] }).paths))
  set(Ipc.modelsImportPick, (_, { state, emit }) => (state.importPick ? startImport(state, emit, state.importPick) : null))
  set(Ipc.modelsImportState, (_, { state }) => state.modelImport)
  // 重新找到…: the own files of the model are where the picker (importPick) points now.
  set(Ipc.modelsRelocate, (payload, { state, emit }) => {
    const { bundleId } = payload as { bundleId: string }
    const bundle = state.catalog.bundles.find((item) => item.id === bundleId)
    const path = state.importPick?.[0]
    if (!bundle || !path) return { found: 0 }
    const ids = new Set(Object.values(bundle.components))
    let found = 0
    state.catalog = {
      ...state.catalog,
      models: state.catalog.models.map((model) => {
        if (!ids.has(model.id) || model.installed || !isOwnFile(model)) return model
        found += 1
        const { missingFile: _gone, ...rest } = model
        return { ...rest, installed: true, installState: 'ready', installedBytes: model.sizeBytes, localPath: path }
      }),
    }
    emit(Events.modelsChanged, null)
    return { found }
  })
  set(Ipc.modelsForget, (payload, { state, emit }) => {
    const { bundleId } = payload as { bundleId: string }
    const bundle = state.catalog.bundles.find((item) => item.id === bundleId)
    if (!bundle) return { ok: true }
    const ids = new Set(Object.values(bundle.components))
    state.catalog = {
      ...state.catalog,
      models: state.catalog.models.filter((model) => !(ids.has(model.id) && model.provider === 'local' && !model.installed)),
      bundles: bundle.custom ? state.catalog.bundles.filter((item) => item.id !== bundleId) : state.catalog.bundles,
    }
    emit(Events.modelsChanged, null)
    return { ok: true }
  })
}
