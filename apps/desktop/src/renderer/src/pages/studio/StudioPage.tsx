import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { GalleryItem, GpuInventorySnapshot, ManagedHost, ProjectCanvas, ProjectLayer } from '@shared/types'
import { normalizeCanvasAdapters } from '@shared/adapters'
import { cliGpuUuids, generationGpus } from '@shared/bundleFit'
import { MAX_QUEUED_RUNS, activeCanvasBranchIds, blockedCanvasIds } from '@shared/canvasJobBranch'
import { Events, Ipc } from '@shared/channels'
import { ScanLine, Sparkles } from 'lucide-react'
import { Button, useToast } from '../../components/ui'
import { TitlebarPortal } from '../../components/shell/Titlebar'
import { AdapterPicker } from '../../components/studio/AdapterPicker'
import { loraProfileStore, recommendedStrength, useLoraProfiles } from '../../components/studio/loraProfilesClient'
import { StudioSidebar } from '../../components/studio/StudioSidebar'
import { installStudioToolBridge, registerStudioTools, type AddedLayer, type LayerBox, type StudioToolApi } from '../../lib/agentTools'
import { call, onEvent } from '../../lib/api'
import { clampBox } from '../../lib/layout'
import { useShell } from '../../lib/shell'
import { useApp } from '../../store'
import { Assistant } from './assistant/Assistant'
import { CollabPanel } from './assistant/CollabPanel'
import { Board, type BoardHandle } from './Board'
import {
  addRegion,
  canvasFromPicture,
  canvasFromReuse,
  createLayoutCanvas,
  defaultSettings,
  editLayer,
  resizeCanvas,
  sceneCanvas,
  settingsFrom,
  type RegionInput,
} from './canvases'
import { clampDimension, isSeedLocked, nearestQuality, qualityPreset, samplingForBundle, SEED_MAX } from './defaults'
import { ImageEditDialog } from './ImageEditDialog'
import { InspectorPanel } from './InspectorPanel'
import type { InputsWiring } from './InputsSection'
import { ACTIVE_JOB_STATES } from './jobStatus'
import { OutputViewer } from './OutputViewer'
import { ParamsPanel } from './ParamsPanel'
import { ProjectSwitcher } from './ProjectSwitcher'
import { canvasDescription, compileCanvasPrompt, withDescription } from './prompt'
import type { BoardTool } from './RegionLayer'
import { StudioPanels, type PanelId } from './StudioPanels'
import { GbcPanel } from './GbcPanel'
import { sizeLike, withParsedRegions } from './pictureRegions'
import type { GbcPicture } from '@shared/gbc'
import { deriveReadiness, isWorkerRun, resolveBundle, type Blocker } from './readiness'
import {
  canvasModelForWorkerPick,
  isWorkerDaemonHost,
  parseWorkerModelPicks,
  resolveWorkerBundle,
  workerAdapterEntries,
  workerAdapterFor,
  workerModelBundles,
  workerModelOrder,
  workerModelsUnread,
} from './remoteWorkerLoras'
import { useWorkerLoras } from './useWorkerLoras'
import { useWorkerModels } from './useWorkerModels'
import { usePreparation } from '../../lib/usePreparation'
import { useBoardAssets } from './useBoardAssets'
import { useEngineFeatures } from './useEngineFeatures'
import { useControlAdapters } from '../../lib/useControlAdapters'
import { GalleryPicker } from './GalleryPicker'
import { linksOf, removeLink, roleLabel, setControlAdapter, setLink, type CanvasLinkEntry, type LinkRole, type PickTarget } from './links'
import { starterCanvas, type Recipe } from './recipes'
import { BOARD_GAP, cardWidth } from './boardLayout'
import {
  createStyleCanvas,
  generationCanvas,
  nodeBlockers,
  seriesFromStyle,
  STYLE_CARD,
  adaptersWithStyles,
  styleLoraNote,
  tryLoraOnBoard,
  upscaleFromPicture,
  upscaleProblem,
  withStartPictureShape,
  withUpscaleSize,
} from './nodes'
import {
  dropRun,
  filmstripOf,
  givesPicture,
  isActiveRun,
  keepCardsShown,
  pictureLink,
  pinRun,
  runsOf,
  unpinRun,
  withRunSettings,
} from './runs'
import { resolveJobInputs } from './jobInputs'
import { useGenerate } from './useGenerate'
import { useInputImport } from './useInputImport'
import { droppedPaths, useModelImport } from '../../lib/modelImport'
import { createExternalSteps, externalFocusMessage, externalFocusOf, useStudioProject, type StepOutcome } from './useStudioProject'
import { LOCAL_HOST_ID, registerStudioCapabilities, type StudioCapabilityDeps } from './studioCapabilities'
import { ownsUndoKey } from './history'
import { usePictureRegions } from './usePictureRegions'

const BUNDLE_KEY = 'mossstudio.modelBundleId'
const HOST_KEY = 'mossstudio.studioHostId'
const WORKER_MODEL_KEY = 'mossstudio.workerModelPicks'
const ASSISTANT_MODE_KEY = 'mossstudio.assistantMode'
const WIDTH_KEY = 'mossstudio.studioPanelWidths'
const UNDERLAY_HANDOFF_KEY = 'clover.studioBackground'

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Remembered choices are conveniences only.
  }
}

function initialWidths(): { left: number; right: number } {
  try {
    const parsed = JSON.parse(readStorage(WIDTH_KEY) ?? '') as { left?: unknown; right?: unknown }
    return {
      left: typeof parsed.left === 'number' ? parsed.left : 320,
      right: typeof parsed.right === 'number' ? parsed.right : 300,
    }
  } catch {
    return { left: 320, right: 300 }
  }
}

/** True while the element is laid out (pages stay mounted but hidden). */
function useIsShown(ref: React.RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(() => setShown(element.getClientRects().length > 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return shown
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}

/** Undo, redo and deletes share one toast: pressing Ctrl+Z again replaces it instead of stacking. */
const HISTORY_TOAST = { key: 'board-history' }
/** What an external Agent did replaces its last note instead of stacking. */
const EXTERNAL_TOAST = { key: 'external-agent' }

/** Blockers the first-run download clears by itself. */
const PREPARING_BLOCKERS = new Set<Blocker['id']>(['model-none', 'model-incomplete', 'engine'])
export function StudioPage(): React.JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const openActivity = useShell((state) => state.openActivity)
  const jobs = useApp((state) => state.jobs)
  const catalog = useApp((state) => state.catalog)
  const settings = useApp((state) => state.settings)
  const engineReadiness = useApp((state) => state.engineReadiness)
  const update = useApp((state) => state.update)
  const pickModelImport = useModelImport((state) => state.pick)
  const startModelImport = useModelImport((state) => state.start)
  const cancelJob = useApp((state) => state.cancelJob)
  const studioBackground = useApp((state) => state.studioBackground)
  const setStudioBackground = useApp((state) => state.setStudioBackground)
  const reuseRequest = useApp((state) => state.studioReuseRequest)
  const tryRequest = useApp((state) => state.studioTryRequest)
  const modelRequest = useApp((state) => state.studioModelRequest)

  const root = useRef<HTMLDivElement>(null)
  const board = useRef<BoardHandle>(null)
  const shown = useIsShown(root)
  const notifyError = useCallback((message: string) => toast.push(message, 'error'), [toast])
  const project = useStudioProject({ jobs, onError: notifyError, active: shown })
  const [edit, setEdit] = useState<{ path: string; session: number } | null>(null)
  const openEdit = useCallback((path: string) => setEdit({ path, session: project.sessionKey }), [project.sessionKey])
  useEffect(() => {
    if (!shown || settings?.externalImageEditEnabled !== true) setEdit(null)
  }, [shown, settings?.externalImageEditEnabled])
  const selected = project.selectedCanvas

  const [savedBundleId, setPreferredBundleId] = useState<string | null>(() => readStorage(BUNDLE_KEY))
  const preferredBundleId = savedBundleId ?? settings?.onboardingModelId ?? null
  const [gpuInventory, setGpuInventory] = useState<GpuInventorySnapshot | null>(null)
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  const [remoteHostId, setRemoteHostId] = useState(() => readStorage(HOST_KEY) ?? '')
  // The model picked on each Worker host, kept apart from the 画面's own (see canvasModelForWorkerPick).
  const [workerPicks, setWorkerPicks] = useState(() => parseWorkerModelPicks(readStorage(WORKER_MODEL_KEY)))
  const [tool, setTool] = useState<BoardTool>('select')
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null)
  const [activePanelId, setActivePanelId] = useState<PanelId | null>(null)
  const assistantOpen = activePanelId === 'assistant'
  const gbcOpen = activePanelId === 'gbc' && settings?.gbcEnabled === true
  // Forget a disabled panel: re-enabling the feature must not reopen it.
  if (activePanelId === 'gbc' && !gbcOpen) setActivePanelId(null)
  /** 助手 is the built-in chat or the 协同 panel for external Agents; the choice is remembered. */
  const [assistantMode, setAssistantMode] = useState<'builtin' | 'collab'>(() =>
    readStorage(ASSISTANT_MODE_KEY) === 'collab' ? 'collab' : 'builtin',
  )
  const chooseAssistantMode = (mode: 'builtin' | 'collab'): void => {
    setAssistantMode(mode)
    writeStorage(ASSISTANT_MODE_KEY, mode)
  }
  const [widths, setWidths] = useState(initialWidths)
  const [viewer, setViewer] = useState<{ canvasId: string; index: number } | null>(null)
  const [adapterPickerOpen, setAdapterPickerOpen] = useState(false)
  // 从作品选择: the input a picture from 作品 goes into.
  // 从作品选择: the input a picture from 作品 goes into, or (right-click on the board) where it goes on the board.
  const [galleryTarget, setGalleryTarget] = useState<PickTarget | { at: { x: number; y: number } } | { underlayOf: string } | null>(null)

  const remoteEnabled = settings?.remoteHostsEnabled === true
  /** 设置 › 功能 › 外部 Agent: the 协同 panel beside the 助手. */
  const externalAgents = settings?.externalAgentsEnabled === true
  /** 运行位置: local (or empty) for this computer, else an SSH host id. */
  const selectRemoteHost = useCallback((id: string) => {
    const next = id === LOCAL_HOST_ID ? '' : id
    setRemoteHostId(next)
    writeStorage(HOST_KEY, next || null)
  }, [])
  const remoteHost = remoteEnabled ? (hosts.find((host) => host.id === remoteHostId) ?? null) : null
  // A Worker daemon picked as 运行位置 reports its own detected models and registered LoRAs.
  const workerHost = isWorkerDaemonHost(remoteHost) ? remoteHost : null
  const workerModels = useWorkerModels(workerHost?.id ?? null)
  const workerModelPick = workerHost ? (workerPicks[workerHost.id] ?? null) : null
  const workerLoras = useWorkerLoras(workerHost?.id ?? null)
  const workerAdapters = useMemo(() => (workerLoras.items ? workerAdapterEntries(workerLoras.items) : null), [workerLoras.items])
  const bundle = workerHost
    ? resolveWorkerBundle(
        workerHost,
        workerModels.inventory,
        workerModelOrder(workerModelPick, selected?.modelBundleId, preferredBundleId),
        catalog,
      )
    : resolveBundle(catalog, selected?.modelBundleId, preferredBundleId)
  const worker = isWorkerRun(bundle.bundle, remoteHost)
  // A legacy Worker binding without a selected Worker cannot use this computer's capabilities.
  const boardFeatures = useEngineFeatures(worker && !workerHost ? null : { deviceUuid: selected?.deviceUuid, hostId: remoteHost?.id })
  const { adapters: controlAdapters, loaded: controlAdaptersLoaded } = useControlAdapters()
  const boardAssets = useBoardAssets({ project, notify: toast.push })
  // Inspector: what the selected canvas's pictures and sampling resolve to.
  // What the selected 画面 generates with: its 风格 applied, a 放大 sized from its 原图.
  const generating = useMemo(
    () => (selected?.kind === 'layout' ? generationCanvas(selected, project.canvases) : null),
    [selected, project.canvases],
  )
  const { canvases } = project
  const inputBlockers = useMemo(
    () =>
      generating
        ? [
            ...nodeBlockers(generating, canvases),
            ...resolveJobInputs(generating, { canvases, features: boardFeatures, worker, controlAdapters, controlAdaptersLoaded }).blockers,
          ]
        : [],
    [generating, canvases, boardFeatures, worker, controlAdapters, controlAdaptersLoaded],
  )
  // The GPUs this canvas may run on: the one it is bound to, else what 设置 allows.
  const gpus = useMemo(
    () =>
      selected?.deviceUuid
        ? (gpuInventory?.devices.filter((device) => device.uuid === selected.deviceUuid) ?? [])
        : generationGpus(gpuInventory?.devices, settings),
    [selected?.deviceUuid, gpuInventory, settings],
  )
  const cliGpus = useMemo(() => cliGpuUuids(engineReadiness), [engineReadiness])
  const loraProfiles = useLoraProfiles()
  const derived = deriveReadiness({
    canvas: generating,
    catalog,
    bundle,
    engine: engineReadiness,
    // While first-run preparation is still going ('active'), its page is where progress shows.
    setupDone: settings ? settings.onboardingState === 'completed' || settings.onboardingState === 'dismissed' : true,
    remote: remoteHost ? { name: remoteHost.name, modelPath: remoteHost.modelPath, remoteBackend: remoteHost.remoteBackend } : null,
    // Until a Worker's model list is read, a run would quietly go to the daemon's default model.
    inputBlockers:
      workerHost && !workerModels.inventory
        ? [...inputBlockers, { id: 'worker-models', message: workerModelsUnread(workerHost.name) }]
        : inputBlockers,
    update,
    features: boardFeatures,
    gpus,
    cliGpus,
    workerAdapters,
    loraProfiles,
    promptAdapters: selected ? adaptersWithStyles(selected, project.canvases) : undefined,
  })
  // A LoRA blocker says when some of the LoRA come from a 风格 (the 画面's own list does not show them).
  const loraNote = selected?.kind === 'layout' ? styleLoraNote(selected, project.canvases) : ''
  const readiness = loraNote
    ? {
        ...derived,
        blockers: derived.blockers.map((blocker) =>
          ['adapters', 'remote-adapters', 'lora-unsupported'].includes(blocker.id)
            ? { ...blocker, message: `${blocker.message}${loraNote}` }
            : blocker,
        ),
      }
    : derived
  // While first-run preparation downloads, 生成 itself says so and fills up; its blockers step aside.
  const { progress: preparing } = usePreparation()
  const waiting = preparing?.active && !remoteHost ? preparing : null
  const panelBlockers = waiting ? readiness.blockers.filter((blocker) => !PREPARING_BLOCKERS.has(blocker.id)) : readiness.blockers
  const busyIds = useMemo(() => activeCanvasBranchIds(project.canvases, jobs), [project.canvases, jobs])
  const blockedIds = useMemo(() => blockedCanvasIds(project.canvases, jobs), [project.canvases, jobs])
  const selectedBlocked = selected ? blockedIds.has(selected.id) : false
  // The selected 画面's own runs: while one goes, 生成 queues another (再来一张), up to MAX_QUEUED_RUNS waiting.
  const selectedFilm = selected?.kind === 'layout' ? filmstripOf(selected, project.canvases) : null
  const selectedGoing = Boolean(selectedFilm?.runs.some((item) => ACTIVE_JOB_STATES.has(item.jobState ?? '')))
  const selectedQueued = selectedFilm?.queued.length ?? 0
  const selectedFull = selectedQueued >= MAX_QUEUED_RUNS
  const { generate } = useGenerate({
    project,
    catalog,
    preferredBundleId,
    remoteHost,
    workerModels: workerHost ? workerModels.inventory : null,
    workerModelPick,
    workerAdapters,
    controlAdapters,
    controlAdaptersLoaded,
    notify: toast.push,
  })
  const inputImport = useInputImport({ project, notify: toast.push })

  useEffect(() => {
    writeStorage(WIDTH_KEY, JSON.stringify(widths))
  }, [widths])

  // A different canvas has its own regions.
  useEffect(() => setSelectedRegionId(null), [project.selectedCanvasId])
  // Leaving the mask tool's canvas ends painting.
  useEffect(() => {
    setTool((current) => (current === 'mask' ? 'select' : current))
  }, [project.selectedCanvasId])

  useEffect(() => {
    void call<GpuInventorySnapshot>(Ipc.gpuInventory)
      .then(setGpuInventory)
      .catch(() => undefined)
    return onEvent<GpuInventorySnapshot>(Events.gpuInventory, setGpuInventory)
  }, [])

  // SSH machines only matter when the 远程主机 feature is on.
  useEffect(() => {
    if (!remoteEnabled) return
    let alive = true
    const load = (): void => {
      void call<ManagedHost[]>(Ipc.hostsList)
        .then((list) => {
          if (alive) setHosts(list.filter((host) => host.kind === 'ssh'))
        })
        .catch(() => undefined)
    }
    load()
    const stop = onEvent(Events.hostsChanged, load)
    return () => {
      alive = false
      stop()
    }
  }, [remoteEnabled])

  // `project` is a new object every render; its refs and actions are stable.
  // Effects depend on those, so a job progress tick does not re-run them.
  const { loaded, canvasesRef, selectedRef, updateCanvas, addCanvas, setCanvases, select } = project

  const applyUnderlay = useCallback(
    (path: string | undefined) => {
      const current = canvasesRef.current.find((canvas) => canvas.id === selectedRef.current)
      if (current?.kind === 'layout') updateCanvas(current.id, { backgroundPath: path })
      else if (path) {
        const created = addCanvas()
        updateCanvas(created.id, { backgroundPath: path })
      }
    },
    [canvasesRef, selectedRef, updateCanvas, addCanvas],
  )

  // A picture chosen as underlay from 作品 arrives through the store (same window)
  // or through localStorage (another window).
  useEffect(() => {
    if (!loaded) return
    if (studioBackground) {
      applyUnderlay(studioBackground.path)
      setStudioBackground(null)
      writeStorage(UNDERLAY_HANDOFF_KEY, null)
      return
    }
    const consume = (): void => {
      const raw = readStorage(UNDERLAY_HANDOFF_KEY)
      if (!raw) return
      writeStorage(UNDERLAY_HANDOFF_KEY, null)
      try {
        const item = JSON.parse(raw) as GalleryItem
        if (typeof item?.path === 'string') applyUnderlay(item.path)
      } catch {
        // A malformed hand-off is dropped.
      }
    }
    consume()
    window.addEventListener('focus', consume)
    return () => window.removeEventListener('focus', consume)
  }, [loaded, studioBackground, setStudioBackground, applyUnderlay])

  // 作品 › 在创作中复用: a new canvas with that image's parameters.
  useEffect(() => {
    if (!loaded || !reuseRequest) return
    const request = useApp.getState().takeStudioReuseRequest()
    if (!request) return
    const list = canvasesRef.current
    const current = list.find((canvas) => canvas.id === selectedRef.current)
    const { canvas, missingAdapters } = canvasFromReuse(request, list, settingsFrom(current), catalog?.adapters ?? [])
    setCanvases([...list, canvas])
    select(canvas.id)
    requestAnimationFrame(() => board.current?.reveal(canvas.id))
    // 用作起始图: the picture comes onto the board beside the new canvas and feeds it.
    if (request.useAs === 'start') {
      void inputImport.importPaths([request.sourcePath], canvas).then(([image]) => {
        if (!image) return
        // Like any first 起始图: the 画面 takes the picture's shape when it differs from the size the request carried.
        setCanvases((previous) =>
          previous.map((item) =>
            item.id === canvas.id ? withStartPictureShape(setLink(item, 'init', { canvasId: image.id }), previous, item) : item,
          ),
        )
      })
    }
    const choice = resolveBundle(catalog, canvas.modelBundleId, preferredBundleId)
    if (request.modelBundleId && (choice.unavailable || !choice.installed)) {
      toast.push(`这张图用的模型「${request.modelName ?? request.modelBundleId}」还没有下载，生成前请先下载或换一个模型`, 'info')
    }
    if (missingAdapters.length) toast.push(`模型库里没有这些 LoRA：${missingAdapters.join('、')}`, 'info')
  }, [loaded, reuseRequest, canvasesRef, selectedRef, setCanvases, select, catalog, preferredBundleId, toast, inputImport])

  // 训练 › 在创作中试用: a 风格 with the trained LoRA and a 画面 wired to it.
  useEffect(() => {
    if (!loaded || !tryRequest) return
    const request = useApp.getState().takeStudioTryRequest()
    if (!request) return
    const list = canvasesRef.current
    // Like a new 画面: the settings of the newest 画面 or result (a 风格 has none of its own).
    const latest = [...list].reverse().find((canvas) => canvas.kind === 'layout' || canvas.kind === 'result')
    const made = tryLoraOnBoard(list, settingsFrom(latest), request)
    setCanvases(made.canvases)
    select(made.layout.id)
    requestAnimationFrame(() => board.current?.fit())
  }, [loaded, tryRequest, canvasesRef, setCanvases, select])

  // 导入模型 › 去创作: the selected 画面 runs with the imported model, and it becomes the one picked next time.
  useEffect(() => {
    if (!loaded || !modelRequest) return
    const id = useApp.getState().takeStudioModelRequest()
    const to = id ? catalog?.bundles.find((item) => item.id === id) : undefined
    if (!id || !to) return
    setPreferredBundleId(id)
    writeStorage(BUNDLE_KEY, id)
    const target = canvasesRef.current.find((canvas) => canvas.id === selectedRef.current)
    if (target?.kind === 'layout') {
      const from = resolveBundle(catalog, target.modelBundleId, id).bundle
      updateCanvas(target.id, (canvas) => ({ ...canvas, ...samplingForBundle(canvas, from, to), modelBundleId: id }))
    }
  }, [loaded, modelRequest, catalog, canvasesRef, selectedRef, updateCanvas])

  const changeSelected = (update: (canvas: ProjectCanvas) => ProjectCanvas): void => {
    if (selected) project.updateCanvas(selected.id, update)
  }
  const changeLayers = (canvasId: string, update: (layers: ProjectLayer[]) => ProjectLayer[]): void => {
    project.updateCanvas(canvasId, (canvas) => ({ ...canvas, layers: update(canvas.layers) }))
  }

  /**
   * Link a picture into a canvas. A 画面 gives the picture on its face (a
   * filmstrip run), and a run used this way is pinned as a card of its own.
   */
  const linkInto = (targetId: string, role: LinkRole, link: CanvasLinkEntry['link'], kind?: string): void => {
    project.setCanvases((previous) => {
      const source = previous.find((canvas) => canvas.id === link.canvasId)
      const target = previous.find((canvas) => canvas.id === targetId)
      // A 画面 whose face has no picture yet (a run just started) has nothing to give.
      if (!source || !target || (source.kind === 'layout' && !givesPicture(source, previous))) return previous
      const resolved = pictureLink(previous, link)
      const linked = setLink(target, role, resolved, kind)
      if (linked === target) return previous
      const next = pinRun(previous, resolved.canvasId)
      // A 放大 takes its size from its 原图, a 画面 that never ran its shape from its first 起始图.
      return next.map((canvas) => (canvas.id === targetId ? withStartPictureShape(withUpscaleSize(linked, next), next, target) : canvas))
    })
  }

  /** 用作起始图 (or a wire dropped on the empty board): a new 画面 fed by a card's picture. */
  const newCanvasFromPicture = (sourceId: string, role: 'init' | 'reference' = 'init', at?: { x: number; y: number }): void => {
    const list = project.canvasesRef.current
    // A picture card has no generation settings; the new 画面 takes the latest canvas's.
    const made = canvasFromPicture(list, sourceId, { role, at, fallback: latestSettings() })
    if (!made) return
    const shaped = withStartPictureShape(made.created, made.canvases)
    project.setCanvases(made.canvases.map((canvas) => (canvas.id === shaped.id ? shaped : canvas)))
    project.select(made.created.id)
    requestAnimationFrame(() => board.current?.reveal(made.created.id))
  }

  const latestSettings = (): ReturnType<typeof settingsFrom> =>
    settingsFrom([...project.canvasesRef.current].reverse().find((canvas) => canvas.kind === 'layout' || canvas.kind === 'result'))

  const regions = usePictureRegions(project, { latestSettings, reveal: (canvasId) => board.current?.reveal(canvasId) })

  /** 解析 made a picture's prompt and boxes into a new 画面 beside the board's cards. */
  const makeCanvasFromParse = (
    picture: GbcPicture,
    source: { path: string; title: string; size?: { width: number; height: number } },
  ): void => {
    const settings = selected?.kind === 'layout' ? settingsFrom(selected) : defaultSettings()
    const shaped = source.size ? { ...settings, ...sizeLike(source.size, settings) } : settings
    const created = createLayoutCanvas(project.canvasesRef.current, shaped)
    const titled = { ...created, title: source.title || created.title }
    const filled = withParsedRegions(titled, { summary: picture.summary, regions: picture.regions })
    project.setCanvases((previous) => [...previous, filled])
    project.select(filled.id)
    requestAnimationFrame(() => board.current?.reveal(filled.id))
  }

  /** 作为参考图: imports the picture beside the board and links it to the selected 画面. */
  const useParsedAsReference = (path: string): void => {
    if (!selected || selected.kind !== 'layout') {
      toast.push('先选中一个画面，再把这张图作为参考', 'error')
      return
    }
    void inputImport.addPaths(selected.id, 'reference', undefined, [path]).then(
      () => toast.push('已作为参考图', 'success'),
      (error: unknown) => toast.push(error instanceof Error ? error.message : String(error), 'error'),
    )
  }

  /** 放大: a 放大 node fed by a card's picture, to its right (or where a wire was dropped). */
  const upscaleFrom = (sourceId: string, at?: { x: number; y: number }): void => {
    const list = project.canvasesRef.current
    const problem = upscaleProblem(list, pictureLink(list, { canvasId: sourceId }))
    if (problem) {
      toast.push(problem, 'info')
      return
    }
    const made = upscaleFromPicture(list, sourceId, { fallback: latestSettings(), at })
    if (!made) return
    project.setCanvases(made.canvases)
    project.select(made.created.id)
    requestAnimationFrame(() => board.current?.reveal(made.created.id))
  }

  /** A new 风格, wired into `canvasId` when given; selected so its description can be written. */
  const addStyle = (canvasId?: string, styleId?: string, at?: { x: number; y: number }): void => {
    if (canvasId && styleId) {
      linkInto(canvasId, 'style', { canvasId: styleId })
      return
    }
    const list = project.canvasesRef.current
    const near = canvasId ? list.find((canvas) => canvas.id === canvasId) : undefined
    const style = createStyleCanvas(
      list,
      at ? { at } : near ? { at: { x: near.x - cardWidth(STYLE_CARD) - BOARD_GAP * 2, y: near.y } } : {},
    )
    project.setCanvases((previous) => {
      const next = [...previous, style]
      return canvasId ? next.map((canvas) => (canvas.id === canvasId ? setLink(canvas, 'style', { canvasId: style.id }) : canvas)) : next
    })
    project.select(style.id)
    requestAnimationFrame(() => (at ? board.current?.keepInView(style.id) : board.current?.reveal(style.id)))
  }

  /** Pick one picture file and bring it onto the board as a picture card. */
  const pickPicture = async (): Promise<ProjectCanvas | null> => {
    const session = project.sessionKey
    let paths: string[]
    try {
      paths = await call<string[]>(Ipc.pickImages, { title: '选择要放大的图' })
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
      return null
    }
    // A pick that comes back after another project was opened was not for that one.
    if (!paths?.length || live.current.project.sessionKey !== session) return null
    const [image] = await inputImport.importPaths(paths.slice(0, 1))
    return image ?? null
  }

  /** Pictures brought onto the board with their first card's corner at `at` (the right-click point). */
  const importAt = async (paths: readonly string[], at: { x: number; y: number }): Promise<void> => {
    const created = await inputImport.importPaths(paths)
    if (!created.length) return
    const first = created[0]!
    const ids = new Set(created.map((card) => card.id))
    // Placing them is part of bringing them in: one step with the import.
    project.history.join(project.history.top('undo'), () =>
      project.setCanvases((previous) =>
        previous.map((canvas) => (ids.has(canvas.id) ? { ...canvas, x: canvas.x - first.x + at.x, y: canvas.y - first.y + at.y } : canvas)),
      ),
    )
    project.select(first.id)
    requestAnimationFrame(() => board.current?.keepInView(first.id))
  }

  const importPicturesAt = async (at: { x: number; y: number }): Promise<void> => {
    const session = project.sessionKey
    let paths: string[]
    try {
      paths = await call<string[]>(Ipc.pickImages, { title: '选择图片' })
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
      return
    }
    // `at` is a point on the board the menu was opened on, not on another project's.
    if (paths?.length && live.current.project.sessionKey === session) await importAt(paths, at)
  }

  /** A new 画面, at a board point when given. */
  const addCanvasAt = (at?: { x: number; y: number }): ProjectCanvas => {
    const created = project.addCanvas()
    // Placed where the user right-clicked, moved back inside the view where it would stick out.
    if (at) {
      project.setCanvases((previous) => previous.map((canvas) => (canvas.id === created.id ? { ...canvas, x: at.x, y: at.y } : canvas)))
      requestAnimationFrame(() => board.current?.keepInView(created.id))
    } else requestAnimationFrame(() => board.current?.reveal(created.id))
    return created
  }

  /** A recipe: nodes laid out and wired, most starting from a picture chosen from a file. */
  const startRecipe = async (recipe: Recipe, at?: { x: number; y: number }): Promise<void> => {
    if (recipe.id === 'series') {
      const series = seriesFromStyle(project.canvasesRef.current, latestSettings())
      project.setCanvases(series.canvases)
      project.select(series.style.id)
      requestAnimationFrame(() => board.current?.fit())
      return
    }
    if (recipe.id === 'upscale') {
      const image = await pickPicture()
      // The picture and the 放大 fed by it are one step.
      if (image) project.history.join(project.history.top('undo'), () => upscaleFrom(image.id))
      return
    }
    if (!recipe.role) return
    const adapter = recipe.role === 'control' ? controlAdapters.find((item) => item.controlKinds.length) : undefined
    if (recipe.role === 'control' && !adapter) return
    // The picture is chosen first, so a cancelled pick leaves the board as it was; a new project's blank 画面 takes it.
    const filled = await inputImport.addFromFile(
      () => {
        const starter = starterCanvas(project.canvasesRef.current)
        const target = starter ?? addCanvasAt(at)
        if (starter) project.select(starter.id)
        if (adapter) project.updateCanvas(target.id, (canvas) => setControlAdapter(canvas, adapter.id))
        return target.id
      },
      recipe.role,
      adapter?.controlKinds[0],
    )
    if (!filled) return
    // It may have grown to the picture's shape, and the picture card beside it should be seen too.
    const made = project.canvasesRef.current.find((canvas) => canvas.id === filled)
    const shown = [filled, ...(made ? linksOf(made).map((entry) => entry.link.canvasId) : [])]
    requestAnimationFrame(() => board.current?.reveal(shown))
    // 局部重绘 goes straight to painting the part to redo.
    if (recipe.id === 'inpaint') setTool('mask')
  }

  const inputsWiring: InputsWiring = {
    canvases: project.canvases,
    features: boardFeatures,
    worker,
    controlAdapters,
    onLinkPicture: (role, kind, sourceId) => {
      if (selected) linkInto(selected.id, role, { canvasId: sourceId }, kind)
    },
    onAddFromFile: (role, kind) => {
      if (selected) void inputImport.addFromFile(selected.id, role, kind)
    },
    onAddFromGallery: (role, kind) => {
      if (selected) setGalleryTarget({ canvasId: selected.id, role, ...(kind ? { kind } : {}) })
    },
    maskTool: tool === 'mask',
    onToggleMask: () => setTool((current) => (current === 'mask' ? 'select' : 'mask')),
    onNavigate: (to) => {
      void navigate(to)
    },
  }

  const run = async (canvasId: string, seed?: 'new' | 'same', smaller?: boolean): Promise<void> => {
    const result = await generate(canvasId, seed, { smaller })
    if (result.canvasId && result.canvasId !== canvasId) board.current?.reveal(result.canvasId)
  }

  const runPrimary = (): void => {
    if (!selected || selected.kind !== 'layout' || selectedBlocked || selectedFull || readiness.blockers.length) return
    void run(selected.id)
  }

  // The assistant drives the canvas through these; every call reads live state.
  const live = useRef({ project, generate, notify: toast.push })
  live.current = { project, generate, notify: toast.push }
  // Capabilities with no built-in tool (cards, wires, runs, projects) for external Agents over MCP.
  const capabilityDeps = useRef<StudioCapabilityDeps | null>(null)
  // An external Agent's call is one undo step, also what it changes after an await.
  const externalSteps = useMemo(() => createExternalSteps((group, run) => live.current.project.history.within(group, run)), [])
  capabilityDeps.current = {
    project: {
      ...project,
      setCanvases: externalSteps.wrap(project.setCanvases),
      updateCanvas: externalSteps.wrap(project.updateCanvas),
      removeCanvas: externalSteps.wrap(project.removeCanvas),
      select: externalSteps.wrap(project.select),
    },
    cancelJob,
    catalog,
    preferredBundleId,
    engineReadiness,
    settings,
    update,
    remoteHost,
    boardFeatures,
    controlAdapters,
    controlAdaptersLoaded,
    gpuInventory,
    jobs,
    remoteHosts: hosts,
    selectRemoteHost,
    problems: () => {
      const { project: p } = live.current
      const canvas = p.canvasesRef.current.find((item) => item.id === p.selectedRef.current)
      if (!canvas) return []
      const compiled = compileCanvasPrompt(canvas)
      return compiled.ok ? [] : compiled.errors
    },
  }
  useEffect(() => registerStudioCapabilities(() => capabilityDeps.current!), [])
  useEffect(() => installStudioToolBridge(), [])
  useEffect(() => {
    const current = (): ProjectCanvas | null => {
      const { project: p } = live.current
      return p.canvasesRef.current.find((canvas) => canvas.id === p.selectedRef.current) ?? null
    }
    const editable = (): ProjectCanvas => {
      const canvas = current()
      if (!canvas) throw new Error('先在画布上选中一个画面')
      if (canvas.kind === 'style') throw new Error('选中的是风格，只能改它的描述')
      if (canvas.kind !== 'layout') throw new Error('选中的是生成结果，不能修改；请先复制成新画面')
      return canvas
    }
    /** Normalised tool box to canvas pixels; edited boxes are clamped here, not invented. */
    const pixelsOf = (value: LayerBox, canvas: ProjectCanvas): [number, number, number, number] =>
      clampBox(
        [value.x * canvas.width, value.y * canvas.height, (value.x + value.w) * canvas.width, (value.y + value.h) * canvas.height],
        canvas.width,
        canvas.height,
      )
    const layerAt = (canvas: ProjectCanvas, index: number): ProjectLayer => {
      const layer = canvas.layers[index - 1]
      if (!layer) throw new Error(`没有第 ${index} 个区域；先用 studio_read_context 看一遍画面`)
      return layer
    }
    const addOne = (input: RegionInput): AddedLayer => {
      const canvas = editable()
      if (canvas.upscale) throw new Error('放大按原图重画，没有区域')
      const { canvas: next, region } = addRegion(canvas, input)
      live.current.project.updateCanvas(canvas.id, () => next)
      return { added: region.id, bbox: region.bbox, index: canvas.layers.length + 1 }
    }
    /** One canvas in the shape the tools read, whichever canvas it is. */
    const viewOf = (canvas: ProjectCanvas) => ({
      id: canvas.id,
      kind: canvas.kind,
      title: canvas.title,
      width: canvas.width,
      height: canvas.height,
      steps: canvas.steps,
      cfg: canvas.cfg,
      seed: isSeedLocked(canvas) ? canvas.seed : 'random',
      prompt: canvasDescription(canvas),
      negative: canvas.negative,
      layers: canvas.layers.map((layer, index) => ({
        index: index + 1,
        label: layer.kind,
        caption: layer.caption,
        text: layer.text,
        bbox: layer.bbox.map((value) => Math.round(value)),
        visible: layer.visible !== false,
      })),
    })
    const api: StudioToolApi = {
      state: () => {
        const canvas = current()
        return { hasSelection: canvas !== null, editable: canvas?.kind === 'layout' }
      },
      readContext: () => {
        const { project: p } = live.current
        const canvas = current()
        return {
          project: { id: p.projectId, name: p.projectName },
          canvases: p.canvasesRef.current.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            width: item.width,
            height: item.height,
            jobState: item.jobState ?? 'idle',
            outputs: item.outputs?.length ?? 0,
          })),
          selected: canvas ? viewOf(canvas) : null,
          notes:
            'prompt is the overall description; the final prompt is compiled from it plus the visible regions. bbox is [x1,y1,x2,y2] in canvas pixels; the tools take normalised 0-1 x/y/w/h. steps snap to 8 (fast), 20 (standard) or 50 (fine). A text region needs both strings: caption is the lettering style, text is exactly what is rendered.',
        }
      },
      readCanvas: (id) => {
        const { project: p } = live.current
        const canvas = p.canvasesRef.current.find((item) => item.id === id)
        if (!canvas) throw new Error(`没有这个画面：${id}`)
        return { ...viewOf(canvas), selected: p.selectedRef.current === id }
      },
      snapshot: () => {
        const canvas = current()
        if (!canvas) return null
        const { project: p } = live.current
        return {
          title: canvas.title,
          description: canvasDescription(canvas),
          width: canvas.width,
          height: canvas.height,
          regions: canvas.layers.map((layer) => ({
            kind: layer.kind,
            caption: layer.caption,
            text: layer.text,
            visible: layer.visible !== false,
          })),
          project: {
            name: p.projectName,
            selectedId: canvas.id,
            canvases: p.canvasesRef.current.map((item) => ({
              id: item.id,
              title: item.title,
              kind: item.kind,
              width: item.width,
              height: item.height,
              jobState: item.jobState ?? 'idle',
            })),
          },
        }
      },
      setPrompt: (value) => {
        // A 风格's description is written the same way.
        const selectedStyle = current()
        const canvas = selectedStyle?.kind === 'style' ? selectedStyle : editable()
        live.current.project.updateCanvas(canvas.id, (item) => withDescription(item, value))
        return { written: value.length }
      },
      setSampler: (patch) => {
        const canvas = editable()
        // The running job already took these values; changing them here would make
        // the canvas describe a different picture than the one being drawn.
        if (canvas.jobState && ACTIVE_JOB_STATES.has(canvas.jobState)) {
          throw new Error('这张画面正在生成，尺寸和采样先别改；等它跑完，或者先取消')
        }
        if (canvas.upscale && (patch.width !== undefined || patch.height !== undefined))
          throw new Error('放大的尺寸跟着原图走，只能改放大倍数')
        let next = canvas
        if (patch.width !== undefined || patch.height !== undefined) {
          next = resizeCanvas(
            next,
            clampDimension(patch.width ?? next.width, next.width),
            clampDimension(patch.height ?? next.height, next.height),
          )
        }
        if (patch.steps !== undefined) {
          const preset = qualityPreset(nearestQuality(patch.steps))
          next = { ...next, steps: preset.steps, cfg: patch.cfg === undefined ? preset.cfg : next.cfg }
        }
        if (patch.cfg !== undefined) next = { ...next, cfg: Math.min(20, Math.max(0, patch.cfg)) }
        if (patch.seed !== undefined) next = { ...next, seed: Math.min(SEED_MAX, Math.max(0, Math.round(patch.seed))), seedLocked: true }
        live.current.project.updateCanvas(canvas.id, () => next)
        return { width: next.width, height: next.height, steps: next.steps, cfg: next.cfg, seed: isSeedLocked(next) ? next.seed : 'random' }
      },
      addLayer: ({ label, caption, bbox }) => addOne({ kind: label, caption, bbox }),
      addTextLayer: ({ caption, text, bbox }) => addOne({ kind: 'text', caption, text, bbox }),
      updateLayer: ({ index, patch }) => {
        const canvas = editable()
        const layer = layerAt(canvas, index)
        const next = editLayer(layer, { ...patch, bbox: patch.bbox ? pixelsOf(patch.bbox, canvas) : undefined }, canvas)
        live.current.project.updateCanvas(canvas.id, (item) => ({
          ...item,
          layers: item.layers.map((entry) => (entry.id === layer.id ? next : entry)),
        }))
        return { updated: layer.id, index }
      },
      removeLayer: (index) => {
        const canvas = editable()
        const layer = layerAt(canvas, index)
        live.current.project.updateCanvas(canvas.id, (item) => ({
          ...item,
          layers: item.layers.filter((entry) => entry.id !== layer.id),
        }))
        return { removed: layer.id, index }
      },
      createScenes: (scenes) => {
        const { project: p } = live.current
        const base = settingsFrom(current())
        const made: ProjectCanvas[] = []
        for (const scene of scenes) {
          made.push(sceneCanvas(scene, [...p.canvasesRef.current, ...made], base))
        }
        p.setCanvases([...p.canvasesRef.current, ...made])
        const last = made[made.length - 1]
        if (last) p.select(last.id)
        return { created: made.map((item) => ({ id: item.id, title: item.title })) }
      },
      selectCanvas: (id) => {
        const { project: p } = live.current
        const canvas = p.canvasesRef.current.find((item) => item.id === id)
        if (!canvas) throw new Error(`没有这个画面：${id}`)
        p.select(id)
        return { selected: id, title: canvas.title }
      },
      generate: async (value) => {
        const canvas = editable()
        if (value?.trim()) live.current.project.updateCanvas(canvas.id, (item) => withDescription(item, value))
        const result = await live.current.generate(canvas.id)
        if (!result.queued) throw new Error(result.error ?? '没有开始生成')
        return result
      },
      problems: () => {
        const canvas = current()
        if (!canvas) return []
        const compiled = compileCanvasPrompt(canvas)
        return compiled.ok ? [] : compiled.errors
      },
      oneStep: (key, call, run) => live.current.project.history.within({ key, label: '助手的修改', call }, run),
      followExternal: async (call, run) => {
        const { project: p } = live.current
        const before = { canvases: p.canvasesRef.current, selectedId: p.selectedRef.current, session: p.sessionKey }
        const result = await externalSteps.follow(call, run)
        const after = live.current.project
        // Opening or creating a project is not the Agent adding every card in it: a new session reports nothing.
        const focus = externalFocusOf(before, {
          canvases: after.canvasesRef.current,
          selectedId: after.selectedRef.current,
          session: after.sessionKey,
        })
        if (focus) {
          requestAnimationFrame(() => board.current?.reveal(focus.canvasId))
          live.current.notify(externalFocusMessage(focus), 'info', undefined, EXTERNAL_TOAST)
        }
        return result
      },
    }
    registerStudioTools(api)
    return () => registerStudioTools(null)
  }, [externalSteps])

  /**
   * Say what an undo or redo did, with the way back tied to that very step: the
   * toast's button does nothing once another step has taken its place.
   */
  const announce = (direction: 'undo' | 'redo', outcome: StepOutcome, offerBack = true): void => {
    if (outcome === 'running') {
      toast.push(direction === 'undo' ? '先取消正在生成的画面再撤销' : '先取消正在生成的画面再重做', 'info', undefined, HISTORY_TOAST)
      return
    }
    if (!outcome) return
    const back =
      direction === 'undo' ? { label: '重做', onClick: () => redoStep(outcome.id) } : { label: '撤销', onClick: () => undoStep(outcome.id) }
    toast.push(`${direction === 'undo' ? '已撤销' : '已重做'} ${outcome.label}`, 'info', offerBack ? back : undefined, HISTORY_TOAST)
  }
  /** Undo (or redo) the latest step; with `only`, just while that step is still the one on top. */
  const undoStep = (only?: number): void => announce('undo', live.current.project.history.undo(only))
  const redoStep = (only?: number): void => announce('redo', live.current.project.history.redo(only))
  /** The toast after an action on the board: its 撤销 takes back that action and nothing else. */
  const undoable = (message: string): void => {
    const id = live.current.project.history.top('undo')
    toast.push(message, 'info', id === null ? undefined : { label: '撤销', onClick: () => undoStep(id) }, HISTORY_TOAST)
  }
  /** The assistant's 撤销这一步: exactly that turn's changes, and only while nothing came after them. */
  const assistantUndo = {
    turn: project.history.turn,
    undo: (calls: readonly string[]): void => announce('undo', live.current.project.history.undoTurn(calls), false),
    redo: (calls: readonly string[]): void => announce('redo', live.current.project.history.redoTurn(calls), false),
  }

  // Keyboard: Ctrl+Enter generates; Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo and redo; V / H / M pick tools; Delete removes a region.
  useEffect(() => {
    if (!shown) return
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        if (document.querySelector('dialog[open]')) return
        event.preventDefault()
        runPrimary()
        return
      }
      const letter = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (letter === 'z' || letter === 'y')) {
        // A text field keeps its own undo; a panel outside the Studio (活动) is not the board's.
        const target = event.target as Node | null
        const outside = target !== document.body && !root.current?.contains(target)
        if (ownsUndoKey(event.target) || outside || document.querySelector('dialog[open]')) return
        event.preventDefault()
        if (letter === 'y' || event.shiftKey) redoStep()
        else undoStep()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) || document.querySelector('dialog[open]')) return
      const key = event.key.toLowerCase()
      if (key === 'v') setTool('select')
      else if (key === 'h') setTool('pan')
      else if (key === 'm') setTool((current) => (current === 'mask' ? 'select' : 'mask'))
      else if (key === 'escape') setSelectedRegionId(null)
      else if ((key === 'delete' || key === 'backspace') && selected?.kind === 'layout' && selectedRegionId) {
        const region = selected.layers.find((layer) => layer.id === selectedRegionId)
        if (!region || region.locked) return
        event.preventDefault()
        changeLayers(selected.id, (layers) => layers.filter((layer) => layer.id !== region.id))
        setSelectedRegionId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** A card that cannot be deleted yet: its job, or (a 画面) any run in its filmstrip, is still going. */
  const stillRunning = (canvas: ProjectCanvas): boolean => {
    const job = canvas.jobId ? jobs.find((item) => item.id === canvas.jobId) : undefined
    const running = canvas.kind === 'layout' && runsOf(canvas, project.canvasesRef.current).some((run) => isActiveRun(run, jobs))
    return ACTIVE_JOB_STATES.has(job?.state ?? '') || running
  }

  /** Cards go at once: the toast, Ctrl+Z and the toolbar bring them back with their runs. */
  const deleteCards = (ids: readonly string[]): void => {
    const list = project.canvasesRef.current.filter((canvas) => ids.includes(canvas.id))
    if (!list.length) return
    if (list.some(stillRunning)) {
      toast.push(list.length > 1 ? '有画面还在生成，先取消再删除' : '这个画面还在生成，先取消再删除', 'info')
      return
    }
    // Generated pictures are files in 作品; a card going does not touch them.
    const ran = list.some((canvas) => canvas.kind === 'result' || runsOf(canvas, project.canvasesRef.current).length > 0)
    let removedLinks = 0
    for (const canvas of list) {
      if (project.canvasesRef.current.some((item) => item.id === canvas.id)) removedLinks += project.removeCanvas(canvas.id)
    }
    const what = list.length === 1 ? `「${list[0]!.title}」` : ` ${list.length} 张卡片`
    const links = removedLinks ? `，并移除了 ${removedLinks} 条连线` : ''
    undoable(`已删除${what}${links}${ran ? '，图片还在作品里' : ''}`)
  }
  const viewerCanvas = viewer ? (project.canvases.find((canvas) => canvas.id === viewer.canvasId) ?? null) : null
  const viewerJob = viewerCanvas?.jobId ? jobs.find((job) => job.id === viewerCanvas.jobId) : undefined

  return (
    <div ref={root} className="studio-workbench flex h-full min-h-0 bg-board">
      {shown && project.loaded ? (
        <TitlebarPortal>
          <ProjectSwitcher project={project} />
          {settings?.gbcEnabled ? (
            <Button
              tone={gbcOpen ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={gbcOpen}
              data-gbc-toggle
              onClick={() => setActivePanelId(gbcOpen ? null : 'gbc')}
              className="no-drag ml-1"
            >
              <ScanLine className="size-3.5" aria-hidden="true" strokeWidth={1.6} />
              解析
            </Button>
          ) : null}
          <Button
            tone={assistantOpen ? 'secondary' : 'ghost'}
            size="xs"
            aria-pressed={assistantOpen}
            data-assistant-toggle
            onClick={() => setActivePanelId(assistantOpen ? null : 'assistant')}
            className="no-drag ml-1"
          >
            <Sparkles className="size-3.5" aria-hidden="true" strokeWidth={1.6} />
            助手
          </Button>
        </TitlebarPortal>
      ) : null}

      <StudioSidebar side="left" label="生成设置" width={widths.left} onWidthChange={(left) => setWidths((value) => ({ ...value, left }))}>
        <ParamsPanel
          canvas={selected}
          regionCount={selected?.layers.length ?? 0}
          catalog={catalog}
          bundle={bundle}
          workerModels={
            workerHost
              ? {
                  models: workerModels.inventory?.models ?? [],
                  unsupported: workerModels.inventory?.unsupported,
                  loading: workerModels.loading,
                  error: workerModels.error,
                  reload: workerModels.reload,
                }
              : null
          }
          workerAdapters={workerHost ? workerAdapters : undefined}
          settings={settings}
          gpuInventory={gpuInventory}
          hosts={hosts}
          remoteHostId={remoteHostId}
          onRemoteHostChange={selectRemoteHost}
          blockers={panelBlockers}
          waiting={waiting}
          prompt={selected ? (readiness.prompt ?? null) : null}
          blocked={selectedBlocked}
          going={selectedGoing}
          queued={selectedQueued}
          full={selectedFull}
          onChange={changeSelected}
          onPickBundle={(id) => {
            // A few-step model (Turbo / Heal) brings its own steps and CFG.
            const from = bundle.bundle
            if (workerHost) {
              const item = workerModels.inventory?.models.find((model) => model.id === id)
              const to = item ? workerModelBundles([item])[0] : undefined
              const over = canvasModelForWorkerPick(item, catalog, selected?.modelBundleId)
              changeSelected((canvas) => ({ ...canvas, ...samplingForBundle(canvas, from, to), modelBundleId: over }))
              const { [workerHost.id]: _previous, ...others } = workerPicks
              const picks = id ? { ...others, [workerHost.id]: { id, over } } : others
              setWorkerPicks(picks)
              writeStorage(WORKER_MODEL_KEY, JSON.stringify(picks))
              return
            }
            const to = catalog?.bundles.find((item) => item.id === id)
            changeSelected((canvas) => ({ ...canvas, ...samplingForBundle(canvas, from, to), modelBundleId: id || undefined }))
            setPreferredBundleId(id)
            writeStorage(BUNDLE_KEY, id || null)
          }}
          onOpenAdapters={() => setAdapterPickerOpen(true)}
          onGenerate={runPrimary}
          onCopyAsLayout={() => {
            if (selected) project.addCanvas(selected)
          }}
          onAddCanvas={() => project.addCanvas()}
          onNavigate={(to) => navigate(to)}
          inputs={inputsWiring}
          onUseAsStart={(id) => newCanvasFromPicture(id)}
          regions={
            <InspectorPanel
              canvas={selected}
              selectedRegionId={selectedRegionId}
              onSelectRegion={setSelectedRegionId}
              onChangeLayers={(update) => {
                if (selected) changeLayers(selected.id, update)
              }}
            />
          }
        />
      </StudioSidebar>

      <main aria-label="画布" className="min-w-120 flex-1">
        {shown && settings?.externalImageEditEnabled === true && edit?.session === project.sessionKey && (
          <ImageEditDialog key={edit.path} path={edit.path} project={project} onClose={() => setEdit(null)} />
        )}
        <Board
          onEditPicture={settings?.externalImageEditEnabled === true ? openEdit : undefined}
          ref={board}
          toolHubEnabled={shown && project.loaded && settings?.toolHubEnabled === true}
          onOpenGbc={() => setActivePanelId('gbc')}
          projectKey={String(project.sessionKey)}
          canvases={project.canvases}
          selectedCanvasId={project.selectedCanvasId}
          jobs={jobs}
          busyIds={busyIds}
          blockedIds={blockedIds}
          update={update}
          blockers={readiness.blockers}
          tool={tool}
          onTool={setTool}
          history={{
            canUndo: project.history.canUndo,
            canRedo: project.history.canRedo,
            onUndo: () => undoStep(),
            onRedo: () => redoStep(),
          }}
          selectedRegionId={selectedRegionId}
          onSelectRegion={setSelectedRegionId}
          onSelectCanvas={(id) => project.select(id)}
          onMoveCanvas={(id, x, y) => project.updateCanvas(id, { x, y })}
          onChangeLayers={changeLayers}
          onUnderlay={(canvasId, pick) =>
            pick ? setGalleryTarget({ underlayOf: canvasId }) : updateCanvas(canvasId, { backgroundPath: undefined })
          }
          onAddCanvas={(at) => void addCanvasAt(at)}
          onImportPictures={(at) => void importPicturesAt(at)}
          onPicturesFromGallery={(at) => setGalleryTarget({ at })}
          onOpenViewer={(canvasId, index) => setViewer({ canvasId, index })}
          onRerun={(canvasId, seed, smaller) => void run(canvasId, seed, smaller)}
          onMoreRuns={(canvasId, count) => {
            for (let index = 0; index < count; index += 1) void generate(canvasId, 'new')
          }}
          onCancel={(jobId) => {
            void cancelJob(jobId).catch((error: unknown) => toast.push(error instanceof Error ? error.message : String(error), 'error'))
          }}
          onCallOff={(runId) => project.setRunCanvases((previous) => dropRun(previous, runId))}
          onShowActivity={(jobId) => openActivity('jobs', jobId ?? null)}
          onCopy={(canvas) => {
            const created = project.addCanvas(canvas)
            requestAnimationFrame(() => board.current?.reveal(created.id))
          }}
          onDelete={(canvas) => deleteCards([canvas.id])}
          onDeleteMany={deleteCards}
          engineFeatures={boardFeatures}
          controlAdapters={controlAdapters}
          onLink={linkInto}
          onRemoveLink={(canvasId, role, at) =>
            project.setCanvases((previous) =>
              keepCardsShown(
                previous,
                previous.map((canvas) => (canvas.id === canvasId ? removeLink(canvas, role, at) : canvas)),
              ),
            )
          }
          onImportImages={(files, at) => {
            void boardAssets.importImages(files, at)
          }}
          onImportModels={(files) => {
            const paths = droppedPaths(files)
            if (paths.length)
              void startModelImport(paths).catch((error: unknown) =>
                toast.push(error instanceof Error ? error.message : String(error), 'error'),
              )
          }}
          onRefuseDrop={() => toast.push('这里只能放图片或模型文件', 'info')}
          onSaveMask={(canvasId, png) => {
            void boardAssets.saveMask(canvasId, png)
          }}
          portActions={{
            onLinkPicture: (canvasId, role, kind, sourceId) => linkInto(canvasId, role, { canvasId: sourceId }, kind),
            onAddFromFile: (canvasId, role, kind) => void inputImport.addFromFile(canvasId, role, kind),
            onAddFromGallery: (canvasId, role, kind) => setGalleryTarget({ canvasId, role, ...(kind ? { kind } : {}) }),
            onSetControlAdapter: (canvasId, adapterId) => project.updateCanvas(canvasId, (canvas) => setControlAdapter(canvas, adapterId)),
            onNavigate: (to) => void navigate(to),
            onAddStyle: addStyle,
          }}
          describeModel={(canvas) => {
            if (workerHost) return { label: `远端主机 · ${workerHost.name}`, ready: true }
            if (!catalog) return null
            const choice = resolveBundle(catalog, canvas.modelBundleId, preferredBundleId)
            if (!choice.bundle) return { label: choice.unavailable ? '找不到选的模型' : '没有模型', ready: false }
            // A remote host's models are checked when the job starts there.
            const ready = choice.installed || Boolean(remoteHost)
            return { label: ready ? choice.bundle.name : `${choice.bundle.name} · 未下载`, ready }
          }}
          onChangeDescription={(canvasId, text) => project.updateCanvas(canvasId, (canvas) => withDescription(canvas, text))}
          onShowOutput={(layoutId, link) => project.updateCanvas(layoutId, { shownOutput: link })}
          onPinRun={(runId, at) => project.setCanvases((previous) => pinRun(previous, runId, at))}
          onUnpinRun={(runId) => {
            const run = project.canvasesRef.current.find((canvas) => canvas.id === runId)
            project.setCanvases((previous) => unpinRun(previous, runId))
            // The card is gone from the board: its 画面 is selected instead.
            if (run?.sourceCanvasId && project.selectedRef.current === runId) project.select(run.sourceCanvasId)
          }}
          onNewFromPicture={newCanvasFromPicture}
          onUseRunSettings={(layoutId, runId) => {
            const run = project.canvasesRef.current.find((canvas) => canvas.id === runId)
            if (!run) return
            project.updateCanvas(layoutId, (canvas) => withRunSettings(canvas, run), '用这次的设置')
            undoable('已换成这次生成用的设置')
          }}
          onDropRun={(runId) => {
            project.setCanvases((previous) => dropRun(previous, runId))
            undoable('已删除这次生成，图片仍保留在作品里')
          }}
          onRecipe={(recipe, at) => void startRecipe(recipe, at)}
          onUpscale={upscaleFrom}
          onAddStyle={(at) => addStyle(undefined, undefined, at)}
          parseBlocker={regions.blocker}
          onParseRegions={regions.parse}
          parsing={regions.parsing}
          onStopParse={regions.stop}
        />
      </main>

      <StudioPanels
        active={activePanelId}
        assistant={
          <StudioSidebar
            side="right"
            label="助手"
            width={widths.right}
            onWidthChange={(right) => setWidths((value) => ({ ...value, right }))}
          >
            <div className="flex h-full min-h-0 flex-col p-4">
              {assistantMode === 'collab' && externalAgents ? (
                <CollabPanel
                  board={{
                    projectId: project.projectId,
                    projectName: project.projectName,
                    canvas: selected,
                    modelName: bundle.bundle?.name,
                    selectedRegionId,
                  }}
                  projectKey={project.sessionKey}
                  visible={assistantOpen}
                  onStandalone={() => chooseAssistantMode('builtin')}
                  projects={project.projects}
                  onCreateProject={project.createProject}
                />
              ) : (
                <Assistant board={assistantUndo} onCollab={externalAgents ? () => chooseAssistantMode('collab') : undefined} />
              )}
            </div>
          </StudioSidebar>
        }
        gbc={
          <StudioSidebar
            side="right"
            label="解析"
            width={widths.right}
            onWidthChange={(right) => setWidths((value) => ({ ...value, right }))}
          >
            <GbcPanel
              canvases={project.canvases}
              onMakeCanvas={makeCanvasFromParse}
              onUseAsReference={selected?.kind === 'layout' ? useParsedAsReference : undefined}
              onClose={() => setActivePanelId(null)}
            />
          </StudioSidebar>
        }
      />

      <GalleryPicker
        open={galleryTarget !== null}
        title={
          galleryTarget && 'role' in galleryTarget
            ? `选择${roleLabel(galleryTarget.role)}`
            : galleryTarget && 'underlayOf' in galleryTarget
              ? '选择描图'
              : '选择图片'
        }
        onClose={() => setGalleryTarget(null)}
        onPick={(path) => {
          const target = galleryTarget
          setGalleryTarget(null)
          if (target && 'role' in target) void inputImport.addPaths(target.canvasId, target.role, target.kind, [path])
          else if (target && 'underlayOf' in target) updateCanvas(target.underlayOf, { backgroundPath: path })
          else if (target) void importAt([path], target.at)
        }}
      />

      <OutputViewer
        canvas={viewerCanvas}
        job={viewerJob}
        catalog={catalog}
        index={viewer?.index ?? 0}
        onIndex={(index) => setViewer((value) => (value ? { ...value, index } : value))}
        onClose={() => setViewer(null)}
      />

      <AdapterPicker
        open={adapterPickerOpen}
        selected={normalizeCanvasAdapters(selected?.adapters)}
        catalog={workerHost ? workerAdapters : catalog?.adapters}
        remoteWorker={
          workerHost
            ? {
                host: { id: workerHost.id, name: workerHost.name },
                loading: workerLoras.loading,
                error: workerLoras.error,
                onChanged: workerLoras.reload,
              }
            : undefined
        }
        onClose={() => setAdapterPickerOpen(false)}
        onToggle={(id) =>
          changeSelected((canvas) => {
            const current = normalizeCanvasAdapters(canvas.adapters)
            if (current.some((item) => item.id === id)) return { ...canvas, adapters: current.filter((item) => item.id !== id) }
            // A Worker LoRA keeps its Worker path when its name is not a portable id.
            const entry = workerHost ? workerAdapters?.find((item) => item.id === id) : undefined
            const strength = recommendedStrength(loraProfileStore.getSnapshot(), entry?.workerId ?? id)
            const added = entry ? workerAdapterFor(entry, strength) : { id, strength }
            return { ...canvas, adapters: normalizeCanvasAdapters([...current, added]) }
          })
        }
        onImport={async () => {
          // The same import as everywhere: the engine recognises the files and puts each where it belongs.
          setAdapterPickerOpen(false)
          await pickModelImport('files').catch((error: unknown) =>
            toast.push(error instanceof Error ? error.message : String(error), 'error'),
          )
        }}
      />
      {regions.dialog}
    </div>
  )
}
