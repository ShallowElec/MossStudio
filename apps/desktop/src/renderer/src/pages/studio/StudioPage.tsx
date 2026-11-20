import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { GalleryItem, GpuInventorySnapshot, ManagedHost, ProjectCanvas, ProjectLayer } from '@shared/types'
import { ADAPTER_STRENGTH_DEFAULT, normalizeCanvasAdapters } from '@shared/adapters'
import { cliGpuUuids, generationGpus } from '@shared/bundleFit'
import { MAX_QUEUED_RUNS, activeCanvasBranchIds, blockedCanvasIds } from '@shared/canvasJobBranch'
import { Events, Ipc } from '@shared/channels'
import { ScanLine, Sparkles } from 'lucide-react'
import { Button, ConfirmDialog, useToast } from '../../components/ui'
import { TitlebarPortal } from '../../components/shell/Titlebar'
import { AdapterPicker } from '../../components/studio/AdapterPicker'
import { StudioSidebar } from '../../components/studio/StudioSidebar'
import { installStudioToolBridge, registerStudioTools, type AddedLayer, type LayerBox, type StudioToolApi } from '../../lib/agentTools'
import { call, onEvent } from '../../lib/api'
import { clampBox } from '../../lib/layout'
import { useShell } from '../../lib/shell'
import { useApp } from '../../store'
import { Assistant } from './assistant/Assistant'
import { Board, type BoardHandle } from './Board'
import {
  addRegion,
  canvasFromPicture,
  canvasFromReuse,
  createLayoutCanvas,
  defaultSettings,
  editLayer,
  removedWith,
  resizeCanvas,
  sceneCanvas,
  settingsFrom,
  type RegionInput,
} from './canvases'
import { clampDimension, isSeedLocked, nearestQuality, qualityPreset, samplingForBundle, SEED_MAX } from './defaults'
import { InspectorPanel } from './InspectorPanel'
import type { InputsWiring } from './InputsSection'
import { ACTIVE_JOB_STATES } from './jobStatus'
import { OutputViewer } from './OutputViewer'
import { ParamsPanel } from './ParamsPanel'
import { ProjectSwitcher } from './ProjectSwitcher'
import { canvasDescription, compileCanvasPrompt, withDescription } from './prompt'
import type { BoardTool } from './RegionLayer'
import { GbcPanel } from './GbcPanel'
import { sizeLike, withParsedRegions } from './pictureRegions'
import type { GbcPicture } from '@shared/gbc'
import { deriveReadiness, resolveBundle, type Blocker } from './readiness'
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
import { useStudioProject } from './useStudioProject'
import { usePictureRegions } from './usePictureRegions'

const BUNDLE_KEY = 'mossstudio.modelBundleId'
const HOST_KEY = 'mossstudio.studioHostId'
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
  const selected = project.selectedCanvas

  const [savedBundleId, setPreferredBundleId] = useState<string | null>(() => readStorage(BUNDLE_KEY))
  const preferredBundleId = savedBundleId ?? settings?.onboardingModelId ?? null
  const [gpuInventory, setGpuInventory] = useState<GpuInventorySnapshot | null>(null)
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  const [remoteHostId, setRemoteHostId] = useState(() => readStorage(HOST_KEY) ?? '')
  const [tool, setTool] = useState<BoardTool>('select')
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null)
  /** 助手 opens beside the board from the title bar; closed, the board takes the room. */
  const [assistantOpen, setAssistantOpen] = useState(false)
  /** 解析 opens beside the board; it and 助手 share the right side. */
  const [gbcOpen, setGbcOpen] = useState(false)
  const [widths, setWidths] = useState(initialWidths)
  const [viewer, setViewer] = useState<{ canvasId: string; index: number } | null>(null)
  const [deleting, setDeleting] = useState<ProjectCanvas | null>(null)
  /** Several picked cards waiting for 删除 to be confirmed. */
  const [deletingMany, setDeletingMany] = useState<string[] | null>(null)
  const [adapterPickerOpen, setAdapterPickerOpen] = useState(false)
  // 从作品选择: the input a picture from 作品 goes into.
  // 从作品选择: the input a picture from 作品 goes into, or (right-click on the board) where it goes on the board.
  const [galleryTarget, setGalleryTarget] = useState<PickTarget | { at: { x: number; y: number } } | { underlayOf: string } | null>(null)

  const remoteEnabled = settings?.remoteHostsEnabled === true
  const remoteHost = remoteEnabled ? (hosts.find((host) => host.id === remoteHostId) ?? null) : null
  const bundle = resolveBundle(catalog, selected?.modelBundleId, preferredBundleId)
  // Board: wires, imported pictures and masks.
  const boardFeatures = useEngineFeatures(
    selected ? { deviceUuid: selected.deviceUuid, hostId: remoteHost?.id } : { hostId: remoteHost?.id },
  )
  const { adapters: controlAdapters, loaded: controlAdaptersLoaded } = useControlAdapters()
  const boardAssets = useBoardAssets({ project, notify: toast.push })
  // Inspector: what the selected canvas's pictures and sampling resolve to.
  // What the selected 画面 generates with: its 风格 applied, a 放大 sized from its 原图.
  const generating = useMemo(
    () => (selected?.kind === 'layout' ? generationCanvas(selected, project.canvases) : null),
    [selected, project.canvases],
  )
  const inputBlockers = useMemo(
    () =>
      generating
        ? [
            ...nodeBlockers(generating, project.canvases),
            ...resolveJobInputs(generating, { canvases: project.canvases, features: boardFeatures, controlAdapters, controlAdaptersLoaded })
              .blockers,
          ]
        : [],
    [generating, project.canvases, boardFeatures, controlAdapters, controlAdaptersLoaded],
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
  const derived = deriveReadiness({
    canvas: generating,
    catalog,
    bundle,
    engine: engineReadiness,
    // While first-run preparation is still going ('active'), its page is where progress shows.
    setupDone: settings ? settings.onboardingState === 'completed' || settings.onboardingState === 'dismissed' : true,
    remote: remoteHost ? { name: remoteHost.name, modelPath: remoteHost.modelPath } : null,
    inputBlockers,
    update,
    features: boardFeatures,
    gpus,
    cliGpus,
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
    project.setCanvases((previous) =>
      previous.map((canvas) => (ids.has(canvas.id) ? { ...canvas, x: canvas.x - first.x + at.x, y: canvas.y - first.y + at.y } : canvas)),
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
      if (image) upscaleFrom(image.id)
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
  const live = useRef({ project, generate })
  live.current = { project, generate }
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
    }
    registerStudioTools(api)
    return () => registerStudioTools(null)
  }, [])

  // Keyboard: Ctrl+Enter generates; V / H / M pick tools; Delete removes a region.
  useEffect(() => {
    if (!shown) return
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        if (document.querySelector('dialog[open]')) return
        event.preventDefault()
        runPrimary()
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

  const deletingRuns = deleting ? removedWith(project.canvases, deleting.id).length - 1 : 0
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
              onClick={() => {
                setGbcOpen((open) => !open)
                setAssistantOpen(false)
              }}
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
            onClick={() => {
              setAssistantOpen((open) => !open)
              setGbcOpen(false)
            }}
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
          settings={settings}
          gpuInventory={gpuInventory}
          hosts={hosts}
          remoteHostId={remoteHostId}
          onRemoteHostChange={(id) => {
            setRemoteHostId(id)
            writeStorage(HOST_KEY, id || null)
          }}
          blockers={panelBlockers}
          waiting={waiting}
          prompt={selected ? (readiness.prompt ?? null) : null}
          blocked={selectedBlocked}
          going={selectedGoing}
          queued={selectedQueued}
          full={selectedFull}
          onChange={changeSelected}
          onPickBundle={(id) => {
            // A few-step model (Turbo) brings its own steps and CFG.
            const from = bundle.bundle
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
        <Board
          ref={board}
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
          onShowActivity={(jobId) => openActivity('jobs', jobId ?? null)}
          onCopy={(canvas) => {
            const created = project.addCanvas(canvas)
            requestAnimationFrame(() => board.current?.reveal(created.id))
          }}
          onDelete={(canvas) => {
            if (stillRunning(canvas)) {
              toast.push('这个画面还在生成，先取消再删除', 'info')
              return
            }
            setDeleting(canvas)
          }}
          onDeleteMany={(ids) => {
            const list = project.canvasesRef.current.filter((canvas) => ids.includes(canvas.id))
            if (list.some(stillRunning)) {
              toast.push('有画面还在生成，先取消再删除', 'info')
              return
            }
            setDeletingMany(list.map((canvas) => canvas.id))
          }}
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
            project.updateCanvas(layoutId, (canvas) => withRunSettings(canvas, run))
            toast.push('已换成这次生成用的设置', 'info')
          }}
          onDropRun={(runId) => {
            project.setCanvases((previous) => dropRun(previous, runId))
            toast.push('已删除这次生成，图片仍保留在作品里', 'info')
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

      {/* Stays mounted while closed, so a running conversation survives. */}
      <div hidden={!assistantOpen || gbcOpen} className="contents">
        <StudioSidebar
          side="right"
          label="助手"
          width={widths.right}
          onWidthChange={(right) => setWidths((value) => ({ ...value, right }))}
        >
          <div className="flex h-full min-h-0 flex-col p-4">
            <Assistant />
          </div>
        </StudioSidebar>
      </div>

      {gbcOpen ? (
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
            onClose={() => setGbcOpen(false)}
          />
        </StudioSidebar>
      ) : null}

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

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? `删除「${deleting.title}」？` : '删除画面？'}
        description={
          deleting?.kind === 'style'
            ? '风格会从项目里删除，接着它的画面不再用它的描述和 LoRA。'
            : deletingRuns
              ? `画面、它的区域和 ${deletingRuns} 次生成会从项目里删除。已经生成的图片仍保留在作品里。`
              : '画面和它的区域会从项目里删除。已经生成的图片仍保留在作品里。'
        }
        confirmLabel={deleting?.kind === 'style' ? '删除风格' : '删除画面'}
        onConfirm={() => {
          if (deleting) {
            const removedLinks = project.removeCanvas(deleting.id)
            if (removedLinks) toast.push(`已删除「${deleting.title}」，并移除了 ${removedLinks} 条连到它的连线`, 'info')
          }
          setDeleting(null)
        }}
      />

      <ConfirmDialog
        open={deletingMany !== null}
        onClose={() => setDeletingMany(null)}
        title={`删除这 ${deletingMany?.length ?? 0} 张卡片？`}
        description="它们的区域和生成记录会从项目里删除。已经生成的图片仍保留在作品里。"
        confirmLabel="删除"
        onConfirm={() => {
          let removedLinks = 0
          for (const id of deletingMany ?? []) {
            if (project.canvasesRef.current.some((canvas) => canvas.id === id)) removedLinks += project.removeCanvas(id)
          }
          if (removedLinks) toast.push(`已删除，并移除了 ${removedLinks} 条连到它们的连线`, 'info')
          setDeletingMany(null)
        }}
      />

      <AdapterPicker
        open={adapterPickerOpen}
        selected={normalizeCanvasAdapters(selected?.adapters)}
        catalog={catalog?.adapters}
        onClose={() => setAdapterPickerOpen(false)}
        onToggle={(id) =>
          changeSelected((canvas) => {
            const current = normalizeCanvasAdapters(canvas.adapters)
            return {
              ...canvas,
              adapters: current.some((item) => item.id === id)
                ? current.filter((item) => item.id !== id)
                : normalizeCanvasAdapters([...current, { id, strength: ADAPTER_STRENGTH_DEFAULT }]),
            }
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
