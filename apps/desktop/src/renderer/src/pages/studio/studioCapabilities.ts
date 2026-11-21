import type {
  Catalog,
  ControlAdapterEntry,
  EngineFeatures,
  EngineReadiness,
  GpuInventorySnapshot,
  JobRecord,
  ManagedHost,
  ProjectCanvas,
  ProjectLayer,
  Settings,
} from '@shared/types'
import type { UpdaterState } from '@shared/update'
import { normalizeCanvasAdapters } from '@shared/adapters'
import { cliGpuUuids, generationGpus } from '@shared/bundleFit'
import { activeCanvasBranchIds } from '@shared/canvasJobBranch'
import type { AppActionArgs, AppActionId, StudioActionArgs, StudioActionId } from '@shared/capabilities'
import { Ipc } from '@shared/channels'
import type { LayerBox } from '../../lib/agentTools'
import { call } from '../../lib/api'
import { clampBox } from '../../lib/layout'
import {
  CapabilityFailure,
  RENDERER_CAPABILITY_HOST,
  type CapabilityExecutionContext,
  type CapabilityHandler,
  type RendererCapabilityHost,
} from '../../lib/capabilities'
import {
  canvasFromPicture,
  copyAsLayout,
  createImageCanvas,
  createLayoutCanvas,
  defaultSettings,
  editLayer,
  reorderLayers,
  settingsFrom,
} from './canvases'
import { canConnect } from './connect'
import { clampDimension, samplingForBundle } from './defaults'
import { resolveJobInputs } from './jobInputs'
import { ACTIVE_JOB_STATES } from './jobStatus'
import { patchControl, patchControlImage, patchInit, patchReferences, removeLink, setControlAdapter, setLink } from './links'
import {
  createStyleCanvas,
  generationCanvas,
  nodeBlockers,
  seriesFromStyle,
  styleLoraNote,
  upscaleFromPicture,
  upscaleProblem,
  withUpscaleScale,
  withUpscaleSize,
} from './nodes'
import { withDescription } from './prompt'
import { deriveReadiness, resolveBundle } from './readiness'
import {
  boardCanvases,
  canDropRun,
  canUnpin,
  dropRun,
  givesPicture,
  keepCardsShown,
  pictureLink,
  pinRun,
  unpinRun,
  withRunSettings,
} from './runs'
import { clampHiresDimension, withHiresPatch, withHiresScale, withSampling } from './sampling'
import { tidyPlaces } from './selection'
import type { StudioProject } from './useStudioProject'

/**
 * Studio capability handlers for the actions that have no built-in assistant
 * tool (cards, wires, runs, projects and the rest). Each one reads live state
 * through `getDeps()` and changes the board with the same pure functions the
 * Studio uses, so it stays testable without React.
 */
export interface StudioCapabilityDeps {
  project: Pick<
    StudioProject,
    'projectId' | 'projectName' | 'canvasesRef' | 'selectedRef' | 'setCanvases' | 'updateCanvas' | 'select' | 'removeCanvas'
  > &
    Partial<Pick<StudioProject, 'openProject' | 'newProject' | 'rename' | 'saveNow' | 'history'>>
  importImageFile?: (projectId: string, path: string) => Promise<{ path: string; width: number; height: number }>
  cancelJob: (jobId: string) => Promise<unknown>
  catalog: Catalog | null
  preferredBundleId: string | null
  engineReadiness: EngineReadiness | null
  settings: Settings | null
  update: UpdaterState | null
  remoteHost: ManagedHost | null
  boardFeatures: EngineFeatures | null | undefined
  controlAdapters: readonly ControlAdapterEntry[]
  controlAdaptersLoaded: boolean
  gpuInventory: GpuInventorySnapshot | null
  jobs: readonly JobRecord[]
  /** What the selected card still lacks, reported after a change. */
  problems: () => string[]
  /** The SSH hosts 运行位置 offers (loaded while the 远程主机 feature is on). */
  remoteHosts?: readonly ManagedHost[]
  /** Switch 运行位置: `local` for this computer, else a host id from `remoteHosts`. */
  selectRemoteHost?: (hostId: string) => void
}

export const LOCAL_HOST_ID = 'local'
const REMOTE_HOSTS_PACK = 'remote.hosts'
const REMOTE_HOSTS_SELECT = 'remote.hosts.select'

function studio<Id extends StudioActionId>(fn: (args: StudioActionArgs<Id>) => unknown): CapabilityHandler {
  return (args) => fn(args as StudioActionArgs<Id>)
}

function app<Id extends AppActionId>(fn: (args: AppActionArgs<Id>, context: CapabilityExecutionContext) => unknown): CapabilityHandler {
  return (args, context) => fn(args as AppActionArgs<Id>, context)
}

export function registerStudioCapabilities(
  getDeps: () => StudioCapabilityDeps,
  host: RendererCapabilityHost = RENDERER_CAPABILITY_HOST,
): () => void {
  const current = (): ProjectCanvas | null => {
    const { project } = getDeps()
    return project.canvasesRef.current.find((canvas) => canvas.id === project.selectedRef.current) ?? null
  }

  const findCanvas = (canvasId?: string): ProjectCanvas => {
    if (!canvasId) {
      const selected = current()
      if (!selected) throw new CapabilityFailure('先在画布上选中一个画面')
      return selected
    }
    const found = getDeps().project.canvasesRef.current.find((canvas) => canvas.id === canvasId)
    if (!found) throw new CapabilityFailure(`没有这个画面：${canvasId}`)
    return found
  }

  const editable = (canvasId?: string): ProjectCanvas => {
    const canvas = findCanvas(canvasId)
    if (canvas.kind === 'style') throw new CapabilityFailure('选中的是风格，只能改它的描述或 LoRA')
    if (canvas.kind !== 'layout') throw new CapabilityFailure('选中的是生成结果，不能修改；请先复制成新画面')
    return canvas
  }

  const ensureNotRunning = (canvas: ProjectCanvas): void => {
    if (canvas.jobState && ACTIVE_JOB_STATES.has(canvas.jobState)) {
      throw new CapabilityFailure('这张画面正在生成，尺寸和采样先别改；等它跑完，或者先取消')
    }
  }

  const pixelsOf = (value: LayerBox, canvas: ProjectCanvas): [number, number, number, number] =>
    clampBox(
      [value.x * canvas.width, value.y * canvas.height, (value.x + value.w) * canvas.width, (value.y + value.h) * canvas.height],
      canvas.width,
      canvas.height,
    )

  const layerById = (canvas: ProjectCanvas, layerId: string): ProjectLayer => {
    const layer = canvas.layers.find((item) => item.id === layerId)
    if (!layer) throw new CapabilityFailure(`没有这个区域：${layerId}`)
    return layer
  }

  const diagnose = (canvas: ProjectCanvas | null) => {
    const deps = getDeps()
    const canvases = deps.project.canvasesRef.current
    const features = deps.boardFeatures ?? null
    if (!canvas)
      return { ready: false, busy: false, canvasId: null, blockers: [{ id: 'selection', message: '先在画布上选中一个画面' }], features }
    const busy = activeCanvasBranchIds(canvases, [...deps.jobs]).has(canvas.id)
    if (canvas.kind !== 'layout') {
      const message = canvas.kind === 'style' ? '风格不能单独生成，把它接到画面上' : '只有可编辑的画面才能生成'
      return { ready: false, busy, canvasId: canvas.id, kind: canvas.kind, blockers: [{ id: 'kind', message }], features }
    }
    const generating = generationCanvas(canvas, canvases)
    const bundle = resolveBundle(deps.catalog, canvas.modelBundleId, deps.preferredBundleId)
    const inputBlockers = [
      ...nodeBlockers(generating, canvases),
      ...resolveJobInputs(generating, {
        canvases,
        features: deps.boardFeatures,
        controlAdapters: deps.controlAdapters,
        controlAdaptersLoaded: deps.controlAdaptersLoaded,
      }).blockers,
    ]
    const gpus = canvas.deviceUuid
      ? (deps.gpuInventory?.devices.filter((device) => device.uuid === canvas.deviceUuid) ?? [])
      : generationGpus(deps.gpuInventory?.devices, deps.settings)
    const derived = deriveReadiness({
      canvas: generating,
      catalog: deps.catalog,
      bundle,
      engine: deps.engineReadiness,
      setupDone: deps.settings ? deps.settings.onboardingState === 'completed' || deps.settings.onboardingState === 'dismissed' : true,
      remote: deps.remoteHost
        ? { name: deps.remoteHost.name, modelPath: deps.remoteHost.modelPath, remoteBackend: deps.remoteHost.remoteBackend }
        : null,
      inputBlockers,
      update: deps.update,
      features: deps.boardFeatures,
      gpus,
      cliGpus: cliGpuUuids(deps.engineReadiness),
    })
    const loraNote = styleLoraNote(canvas, canvases)
    const blockers = derived.blockers.map((blocker) => ({
      id: blocker.id,
      message:
        loraNote && ['adapters', 'remote-adapters', 'lora-unsupported'].includes(blocker.id)
          ? `${blocker.message}${loraNote}`
          : blocker.message,
      ...(blocker.action ? { action: blocker.action } : {}),
    }))
    return {
      ready: !busy && blockers.length === 0,
      busy,
      canvasId: canvas.id,
      kind: canvas.kind,
      bundleId: bundle.bundle?.id ?? null,
      blockers,
      features,
    }
  }

  const options = {
    checkState: () => {
      const canvas = current()
      return { hasSelection: canvas !== null, editable: canvas?.kind === 'layout', selectedKind: canvas?.kind }
    },
    readProblems: () => getDeps().problems(),
  }

  const disposers = [
    host.registerPackHandlers(
      'studio.board.read',
      {
        'studio.board.diagnose': studio<'studio.board.diagnose'>(({ canvasId }) => diagnose(canvasId ? findCanvas(canvasId) : current())),
      },
      options,
    ),
    host.registerPackHandlers(
      'studio.board.cards',
      {
        'studio.cards.create': studio<'studio.cards.create'>(({ title, prompt, width, height, modelBundleId, select = true }) => {
          const { project, catalog } = getDeps()
          if (modelBundleId && catalog && !catalog.bundles.some((item) => item.id === modelBundleId)) {
            throw new CapabilityFailure(`模型库里没有这个模型：${modelBundleId}`)
          }
          const base = settingsFrom(current())
          let created = createLayoutCanvas(project.canvasesRef.current, {
            ...base,
            ...(width !== undefined ? { width: clampDimension(width, base.width) } : {}),
            ...(height !== undefined ? { height: clampDimension(height, base.height) } : {}),
            ...(modelBundleId ? { modelBundleId } : {}),
          })
          if (title) created = { ...created, title }
          if (prompt !== undefined) created = withDescription(created, prompt)
          project.setCanvases([...project.canvasesRef.current, created])
          if (select) project.select(created.id)
          return { id: created.id, title: created.title, width: created.width, height: created.height }
        }),
        'studio.cards.duplicate': studio<'studio.cards.duplicate'>(({ canvasId, select = true }) => {
          const { project } = getDeps()
          const source = findCanvas(canvasId)
          if (source.kind === 'image' || source.kind === 'style') throw new CapabilityFailure('只有画面或生成结果可以复制为新画面')
          const copy = copyAsLayout(source, project.canvasesRef.current)
          project.setCanvases([...project.canvasesRef.current, copy])
          if (select) project.select(copy.id)
          return { id: copy.id, title: copy.title, sourceId: source.id }
        }),
        'studio.cards.create_style': studio<'studio.cards.create_style'>(({ title, prompt, adapters, select = false }) => {
          const { project } = getDeps()
          let created = createStyleCanvas(project.canvasesRef.current)
          if (title) created = { ...created, title }
          if (prompt !== undefined) created = withDescription(created, prompt)
          if (adapters) created = { ...created, adapters: normalizeCanvasAdapters(adapters) }
          project.setCanvases([...project.canvasesRef.current, created])
          if (select) project.select(created.id)
          return { id: created.id, title: created.title }
        }),
        'studio.cards.create_upscale': studio<'studio.cards.create_upscale'>(({ sourceCanvasId, scale, strength, select = true }) => {
          const { project } = getDeps()
          const canvases = project.canvasesRef.current
          const source = findCanvas(sourceCanvasId)
          if (!givesPicture(source, canvases)) throw new CapabilityFailure('这张卡片还没有可用的图片，不能放大')
          const problem = upscaleProblem(canvases, pictureLink(canvases, { canvasId: sourceCanvasId }))
          if (problem) throw new CapabilityFailure(problem)
          const built = upscaleFromPicture(canvases, sourceCanvasId, { fallback: settingsFrom(current()) })
          if (!built) throw new CapabilityFailure('这张图片无法创建放大节点')
          let created = built.created
          if (scale !== undefined) created = withUpscaleScale(created, scale, built.canvases)
          if (strength !== undefined) created = patchInit(created, { strength })
          project.setCanvases(built.canvases.map((item) => (item.id === created.id ? created : item)))
          if (select) project.select(created.id)
          return { id: created.id, title: created.title, width: created.width, height: created.height, scale: created.upscale?.scale ?? 2 }
        }),
        'studio.cards.set_upscale_scale': studio<'studio.cards.set_upscale_scale'>(({ canvasId, scale }) => {
          const { project } = getDeps()
          const canvas = editable(canvasId)
          if (!canvas.upscale) throw new CapabilityFailure('这张画面不是放大节点')
          ensureNotRunning(canvas)
          const next = withUpscaleScale(canvas, scale, project.canvasesRef.current)
          project.updateCanvas(canvas.id, () => next)
          return { id: next.id, scale: next.upscale?.scale ?? scale, width: next.width, height: next.height }
        }),
        'studio.cards.delete': studio<'studio.cards.delete'>(({ canvasId }) => {
          const target = findCanvas(canvasId)
          const removedLinks = getDeps().project.removeCanvas(target.id)
          return { deleted: target.id, title: target.title, removedLinks }
        }),
        'studio.cards.tidy': studio<'studio.cards.tidy'>(({ canvasIds }) => {
          const { project } = getDeps()
          const visible = boardCanvases(project.canvasesRef.current)
          const targets = canvasIds ? visible.filter((item) => canvasIds.includes(item.id)) : visible
          if (targets.length < 2) return { moved: 0 }
          const places = new Map(tidyPlaces(targets).map((item) => [item.id, item]))
          project.setCanvases((previous) =>
            previous.map((item) => {
              const spot = places.get(item.id)
              return spot ? { ...item, x: spot.x, y: spot.y } : item
            }),
          )
          return { moved: places.size }
        }),
      },
      options,
    ),
    host.registerPackHandlers(
      'studio.board.regions',
      {
        'studio.regions.update_by_id': studio<'studio.regions.update_by_id'>(({ canvasId, layerId, ...patch }) => {
          const canvas = editable(canvasId)
          if (canvas.upscale) throw new CapabilityFailure('放大按原图重画，没有区域')
          const layer = layerById(canvas, layerId)
          const next = editLayer(layer, { ...patch, bbox: patch.bbox ? pixelsOf(patch.bbox, canvas) : undefined }, canvas)
          getDeps().project.updateCanvas(canvas.id, (item) => ({
            ...item,
            layers: item.layers.map((entry) => (entry.id === layer.id ? next : entry)),
          }))
          return { canvasId: canvas.id, updated: layer.id }
        }),
        'studio.regions.remove_by_id': studio<'studio.regions.remove_by_id'>(({ canvasId, layerId }) => {
          const canvas = editable(canvasId)
          const layer = layerById(canvas, layerId)
          getDeps().project.updateCanvas(canvas.id, (item) => ({ ...item, layers: item.layers.filter((entry) => entry.id !== layer.id) }))
          return { canvasId: canvas.id, removed: layer.id }
        }),
        'studio.regions.reorder': studio<'studio.regions.reorder'>(({ canvasId, fromLayerId, toLayerId }) => {
          const canvas = editable(canvasId)
          layerById(canvas, fromLayerId)
          layerById(canvas, toLayerId)
          const reordered = reorderLayers(canvas.layers, fromLayerId, toLayerId)
          getDeps().project.updateCanvas(canvas.id, (item) => ({ ...item, layers: reordered }))
          return { canvasId: canvas.id, order: reordered.map((layer) => layer.id) }
        }),
      },
      options,
    ),
    host.registerPackHandlers(
      'studio.board.sampling',
      {
        'studio.sampling.set_model': studio<'studio.sampling.set_model'>(({ canvasId, modelBundleId }) => {
          const { project, catalog } = getDeps()
          const canvas = editable(canvasId)
          ensureNotRunning(canvas)
          const bundle = catalog?.bundles.find((item) => item.id === modelBundleId)
          if (catalog && !bundle) throw new CapabilityFailure(`模型库里没有这个模型：${modelBundleId}`)
          const fromBundle = canvas.modelBundleId ? catalog?.bundles.find((item) => item.id === canvas.modelBundleId) : undefined
          const sampled = bundle ? samplingForBundle(canvas, fromBundle, bundle) : null
          const next: ProjectCanvas = { ...canvas, modelBundleId, ...(sampled ? { steps: sampled.steps, cfg: sampled.cfg } : {}) }
          project.updateCanvas(canvas.id, () => next)
          return { canvasId: canvas.id, modelBundleId, steps: next.steps, cfg: next.cfg }
        }),
        'studio.sampling.set_loras': studio<'studio.sampling.set_loras'>(({ canvasId, adapters }) => {
          const target = findCanvas(canvasId)
          if (target.kind !== 'layout' && target.kind !== 'style') throw new CapabilityFailure('只有画面或风格可以配置 LoRA')
          const normalized = normalizeCanvasAdapters(adapters)
          getDeps().project.updateCanvas(target.id, (item) => ({ ...item, adapters: normalized }))
          return { canvasId: target.id, adapters: normalized }
        }),
        'studio.sampling.set_advanced': studio<'studio.sampling.set_advanced'>(
          ({ canvasId, sampler, scheduler, shift, stepCache, cfgTruncation, hires }) => {
            const canvas = editable(canvasId)
            ensureNotRunning(canvas)
            if (canvas.upscale && hires?.enabled) throw new CapabilityFailure('放大节点不支持再叠加高清修复')
            let next = canvas
            const patch: Partial<NonNullable<ProjectCanvas['sampling']>> = {}
            if (sampler !== undefined) patch.sampler = sampler || undefined
            if (scheduler !== undefined) patch.scheduler = scheduler || undefined
            if (shift !== undefined) patch.shift = shift ?? undefined
            if (stepCache !== undefined) patch.stepCache = stepCache || undefined
            if (cfgTruncation !== undefined) patch.cfgTruncation = cfgTruncation ?? undefined
            if (Object.keys(patch).length > 0) next = withSampling(next, patch)
            if (hires !== undefined) {
              if (!hires.enabled) next = withSampling(next, { hires: undefined })
              else {
                if (hires.scale !== undefined) next = withHiresScale(next, hires.scale)
                else if (hires.width !== undefined || hires.height !== undefined) {
                  const was = next.sampling?.hires
                  next = withSampling(next, {
                    hires: {
                      ...was,
                      width: clampHiresDimension(hires.width ?? was?.width ?? next.width, next.width),
                      height: clampHiresDimension(hires.height ?? was?.height ?? next.height, next.height),
                    },
                  })
                } else if (!next.sampling?.hires) next = withHiresScale(next, 1.5)
                if (hires.steps !== undefined || hires.strength !== undefined) {
                  next = withHiresPatch(next, {
                    ...(hires.steps !== undefined ? { steps: hires.steps } : {}),
                    ...(hires.strength !== undefined ? { strength: hires.strength } : {}),
                  })
                }
              }
            }
            getDeps().project.updateCanvas(canvas.id, () => next)
            return { canvasId: canvas.id, sampling: next.sampling ?? null }
          },
        ),
      },
      options,
    ),
    host.registerPackHandlers(
      'studio.board.wires',
      {
        'studio.wires.connect': studio<'studio.wires.connect'>(({ sourceCanvasId, targetCanvasId, role, kind, output }) => {
          const { project } = getDeps()
          const canvases = project.canvasesRef.current
          const source = findCanvas(sourceCanvasId)
          const target = editable(targetCanvasId)
          if (role === 'style') {
            if (source.kind !== 'style') throw new CapabilityFailure('风格端口只能连接风格卡片')
            if (target.upscale) throw new CapabilityFailure('放大节点不能连接风格')
          } else {
            if (source.kind === 'style') throw new CapabilityFailure('风格卡片只能连接到风格端口')
            if (!givesPicture(source, canvases)) throw new CapabilityFailure('源卡片还没有可用的图片')
            if (role === 'control' && !kind) throw new CapabilityFailure('控制图连线需要指定 kind（如 depth / canny / pose）')
            if (target.upscale && role !== 'init') throw new CapabilityFailure('放大节点只能连接原图（init）')
          }
          const check = canConnect(canvases, source.id, target)
          if (!check.ok) throw new CapabilityFailure(check.reason ?? '不能这样连线')
          const link =
            role === 'style'
              ? { canvasId: source.id }
              : pictureLink(canvases, { canvasId: source.id, ...(output !== undefined ? { output } : {}) })
          const pinned = role === 'style' ? [...canvases] : pinRun(canvases, link.canvasId)
          let updated = setLink(target, role, link, kind)
          if (updated.upscale && role === 'init') updated = withUpscaleSize(updated, pinned)
          project.setCanvases(pinned.map((item) => (item.id === target.id ? updated : item)))
          return { targetCanvasId: target.id, sourceCanvasId: link.canvasId, role, ...(kind ? { kind } : {}) }
        }),
        'studio.wires.disconnect': studio<'studio.wires.disconnect'>(({ targetCanvasId, role, kind, index }) => {
          const { project } = getDeps()
          const before = project.canvasesRef.current
          const target = editable(targetCanvasId)
          const which = role === 'control' ? (kind ?? index) : index
          if ((role === 'reference' || role === 'style') && which === undefined)
            throw new CapabilityFailure(`断开 ${role} 连线需要提供 0-based index`)
          if (role === 'control' && which === undefined) throw new CapabilityFailure('断开控制图连线需要提供 kind 或 index')
          const updated = removeLink(target, role, which)
          project.setCanvases(
            keepCardsShown(
              before,
              before.map((item) => (item.id === target.id ? updated : item)),
            ),
          )
          return { targetCanvasId: target.id, role, disconnected: updated !== target }
        }),
        'studio.wires.configure_init': studio<'studio.wires.configure_init'>(({ canvasId, strength, resize }) => {
          const canvas = editable(canvasId)
          if (!canvas.inputs?.init) throw new CapabilityFailure('这张画面还没有连接起始图')
          const next = patchInit(canvas, {
            ...(strength !== undefined ? { strength } : {}),
            ...(resize !== undefined ? { resize: resize ?? undefined } : {}),
          })
          getDeps().project.updateCanvas(canvas.id, () => next)
          return { canvasId: canvas.id, init: next.inputs?.init ?? null }
        }),
        'studio.wires.configure_control': studio<'studio.wires.configure_control'>(({ canvasId, adapterId, loraStrength, image }) => {
          const canvas = editable(canvasId)
          let next = canvas
          if (adapterId !== undefined) next = setControlAdapter(next, adapterId)
          if (loraStrength !== undefined) {
            if (!next.inputs?.control) throw new CapabilityFailure('先选择一个控制适配器再调整强度')
            next = patchControl(next, { loraStrength: loraStrength ?? undefined })
          }
          if (image) {
            if (!next.inputs?.control) throw new CapabilityFailure('这张画面还没有连接控制图')
            const { kind, ...patch } = image
            next = patchControlImage(next, kind, patch)
          }
          getDeps().project.updateCanvas(canvas.id, () => next)
          return { canvasId: canvas.id, control: next.inputs?.control ?? null }
        }),
        'studio.wires.configure_references': studio<'studio.wires.configure_references'>(({ canvasId, maxEdge }) => {
          const canvas = editable(canvasId)
          if (!canvas.inputs?.references) throw new CapabilityFailure('这张画面还没有连接参考图')
          const next = patchReferences(canvas, { maxEdge: maxEdge ?? undefined })
          getDeps().project.updateCanvas(canvas.id, () => next)
          return { canvasId: canvas.id, references: next.inputs?.references ?? null }
        }),
        'studio.wires.apply_recipe': studio<'studio.wires.apply_recipe'>(({ recipe, sourceCanvasId, select = true }) => {
          const { project } = getDeps()
          const canvases = project.canvasesRef.current
          const selected = current()
          const base = selected ? settingsFrom(selected) : defaultSettings()
          if (recipe === 'series') {
            const built = seriesFromStyle(canvases, base)
            project.setCanvases(built.canvases)
            if (select) project.select(built.style.id)
            return { recipe, styleId: built.style.id, layoutIds: built.layouts.map((item) => item.id) }
          }
          if (!sourceCanvasId) throw new CapabilityFailure(`配方 ${recipe} 需要提供 sourceCanvasId`)
          const source = findCanvas(sourceCanvasId)
          if (!givesPicture(source, canvases)) throw new CapabilityFailure('源卡片还没有可用的图片')
          const built =
            recipe === 'upscale'
              ? upscaleFromPicture(canvases, source.id, { fallback: base })
              : canvasFromPicture(canvases, source.id, { role: recipe === 'edit' ? 'init' : 'reference', fallback: base })
          if (!built) throw new CapabilityFailure('这张图片无法套用该配方')
          project.setCanvases(built.canvases)
          if (select) project.select(built.created.id)
          return { recipe, createdId: built.created.id }
        }),
      },
      options,
    ),
    host.registerPackHandlers(
      'studio.board.runs',
      {
        'studio.runs.cancel': studio<'studio.runs.cancel'>(async ({ canvasId, jobId }) => {
          const deps = getDeps()
          let target = jobId
          if (!target) {
            const canvas = canvasId ? findCanvas(canvasId) : current()
            if (!canvas) throw new CapabilityFailure('先选中一个画面或指定 jobId')
            if (canvas.jobId && canvas.jobState && ACTIVE_JOB_STATES.has(canvas.jobState)) target = canvas.jobId
            else {
              target = deps.project.canvasesRef.current.find(
                (item) => item.sourceCanvasId === canvas.id && item.jobId && item.jobState && ACTIVE_JOB_STATES.has(item.jobState),
              )?.jobId
            }
          }
          if (!target) throw new CapabilityFailure('当前没有正在运行的生成任务')
          await deps.cancelJob(target)
          return { canceled: true, jobId: target }
        }),
        'studio.runs.pin': studio<'studio.runs.pin'>(({ runId }) => {
          const { project } = getDeps()
          if (findCanvas(runId).kind !== 'result') throw new CapabilityFailure('只有生成结果可以固定到画板')
          project.setCanvases(pinRun(project.canvasesRef.current, runId))
          return { pinned: runId }
        }),
        'studio.runs.unpin': studio<'studio.runs.unpin'>(({ runId }) => {
          const { project } = getDeps()
          const canvases = project.canvasesRef.current
          if (!canUnpin(findCanvas(runId), canvases)) throw new CapabilityFailure('这张结果卡片不能收回（未固定，或源画面已不存在）')
          project.setCanvases(unpinRun(canvases, runId))
          return { unpinned: runId }
        }),
        'studio.runs.apply_settings': studio<'studio.runs.apply_settings'>(({ layoutCanvasId, runId }) => {
          const { project } = getDeps()
          const run = findCanvas(runId)
          const layout = editable(layoutCanvasId ?? run.sourceCanvasId)
          if (run.id === layout.id) throw new CapabilityFailure('不能把画面的设置套用到自己身上')
          project.updateCanvas(layout.id, () => withRunSettings(layout, run))
          return { layoutCanvasId: layout.id, fromRunId: run.id }
        }),
        'studio.runs.drop': studio<'studio.runs.drop'>(({ runId }) => {
          const { project } = getDeps()
          const canvases = project.canvasesRef.current
          findCanvas(runId)
          if (!canDropRun(canvases, runId)) throw new CapabilityFailure('这张运行已被固定或正在被其他画面使用，不能从胶片条删除')
          project.setCanvases(dropRun(canvases, runId))
          return { dropped: runId }
        }),
      },
      options,
    ),
    host.registerPackHandlers(
      'studio.projects',
      {
        'studio.projects.open': app<'studio.projects.open'>(async ({ id }) => {
          const { project } = getDeps()
          if (!project.openProject) throw new CapabilityFailure('当前环境不支持切换项目')
          await project.openProject(id)
          return { opened: id }
        }),
        'studio.projects.create': app<'studio.projects.create'>(async ({ name }) => {
          const { project } = getDeps()
          if (!project.newProject) throw new CapabilityFailure('当前环境不支持新建项目')
          await project.newProject()
          if (name) getDeps().project.rename?.(name)
          const saved = (await getDeps().project.saveNow?.()) ?? null
          const live = getDeps().project
          return { created: true, id: saved?.id ?? live.projectId, name: name ?? live.projectName }
        }),
        'studio.projects.rename': app<'studio.projects.rename'>(({ name }) => {
          const { project } = getDeps()
          if (!project.rename) throw new CapabilityFailure('当前环境不支持重命名项目')
          project.rename(name)
          return { renamed: name }
        }),
        'studio.projects.save': app<'studio.projects.save'>(async () => {
          const { project } = getDeps()
          if (!project.saveNow) throw new CapabilityFailure('当前环境不支持立即保存')
          const saved = await project.saveNow()
          return { saved: Boolean(saved), id: saved?.id ?? project.projectId, updatedAt: saved?.updatedAt ?? null }
        }),
        'studio.projects.import_image': app<'studio.projects.import_image'>(async ({ path, select = true }, context) => {
          const deps = getDeps()
          let projectId = deps.project.projectId
          if (!projectId && deps.project.saveNow) projectId = (await deps.project.saveNow())?.id ?? null
          if (!projectId) throw new CapabilityFailure('项目还没保存好，图片暂时放不进来')
          const importer =
            deps.importImageFile ??
            ((pid: string, source: string) =>
              call<{ path: string; width: number; height: number }>(Ipc.studioImportImage, { projectId: pid, path: source }))
          const imported = await importer(projectId, path)
          const { project } = getDeps()
          const created = createImageCanvas(project.canvasesRef.current, imported)
          const place = (): void => {
            project.setCanvases([...project.canvasesRef.current, created])
            if (select) project.select(created.id)
          }
          // The caller's history group closed when the import started to wait; the card joins
          // that same step (followExternal keys it by the call id), so one undo takes it back.
          if (project.history)
            project.history.within({ key: `external:${context.callId}`, label: '外部 Agent 的修改', call: context.callId }, place)
          else place()
          return { id: created.id, title: created.title, path: imported.path, width: imported.width, height: imported.height }
        }),
      },
      options,
    ),
  ]

  // `remote.hosts` is a shared pack that an older registry (or a test double) may not have yet.
  if (host.registry.getAction(REMOTE_HOSTS_SELECT)?.descriptor.packId === REMOTE_HOSTS_PACK) {
    disposers.push(
      host.registerPackHandlers(REMOTE_HOSTS_PACK, {
        [REMOTE_HOSTS_SELECT]: (args) => {
          const deps = getDeps()
          const hostId = typeof args.hostId === 'string' ? args.hostId.trim() : ''
          if (!hostId) throw new CapabilityFailure(`请提供 hostId：「${LOCAL_HOST_ID}」表示本机，或远程主机的 id`)
          if (!deps.selectRemoteHost) throw new CapabilityFailure('当前环境不支持切换运行位置')
          if (hostId !== LOCAL_HOST_ID) {
            if (deps.settings?.remoteHostsEnabled !== true) throw new CapabilityFailure('远程主机功能还没打开，请先在设置里开启')
            if (!deps.remoteHosts?.some((item) => item.id === hostId)) {
              throw new CapabilityFailure(`没有这个远程主机：${hostId}`)
            }
          }
          deps.selectRemoteHost(hostId)
          return { ok: true, hostId }
        },
      }),
    )
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}
