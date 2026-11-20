import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import type {
  CanvasImageLink,
  ControlAdapterEntry,
  EngineFeatures,
  GalleryItem,
  JobRecord,
  ProjectCanvas,
  ProjectLayer,
  ProjectLayerKind,
} from '@shared/types'
import { cn } from '../../components/ui'
import {
  CARD_HEADER,
  boardBounds,
  cardBodyHeight,
  cardRect,
  cardWidth,
  centerOn,
  fitView,
  nextFreeSpot,
  toBoardPoint,
  zoomAround,
  type Rect,
  type View,
} from './boardLayout'
import { CanvasCard, type CardMenuAction, type CardStrip } from './CanvasCard'
import type { ParseView } from './CardStatus'
import { PARSE_CHECKING } from '@shared/gbc'
import { useShell } from '../../lib/shell'
import { newCanvasMenu } from './connect'
import { boardTakesDrag, isImageFile, sortBoardDrop } from './imageNodes'
import { cardJobView, type CardJobView } from './jobStatus'
import { LinkMenu } from './LinkMenu'
import { linkSourceImage, type LinkRole } from './links'
import { BRUSH_DEFAULT, maskAvailability, startPictureSize } from './mask'
import type { MaskBrush, MaskCommand } from './MaskLayer'
import { rerunEligibility, type Blocker, type ReadinessInput } from './readiness'
import { KIND_LABEL, withKind, type BoardTool } from './RegionLayer'
import { CardToolbar, MaskBar, Toolbar } from './Toolbar'
import { useCardDrag } from './useCardDrag'
import { useWireConnect } from './useWireConnect'
import { useWireSelection } from './useWireSelection'
import { InputAdder, InputThumbs, SelectionBar, StartRow } from './BoardControls'
import { MINIMAP_BOX, Minimap } from './Minimap'
import { boundsOf, boxBetween, cardsInBox, readingOrder, tidyPlaces, toggled } from './selection'
import { BoardMenu, type BoardMenuEntry } from './BoardMenu'
import type { PortActions } from './SlotMenu'
import { inputSlots, socketY } from './ports'
import { WireChips, WireLayer } from './WireLayer'
import { recipes, type Recipe } from './recipes'
import { upscaleProblem } from './nodes'
import { plannedRegions } from './canvases'
import {
  boardCanvases,
  canDropRun,
  canUnpin,
  filmstripOf,
  foldedRunIds,
  givesPicture,
  isActiveRun,
  pictureLink,
  runsOf,
  unpinRun,
  type StripItem,
} from './runs'
import { useRunDrag } from './useRunDrag'
import { useStableCallbacks } from './useStableCallbacks'
import { boardPorts, type Point } from './wires'
import { OutputImage } from './OutputImage'

const FIT_PADDING = { top: 116, side: 48 }

export interface BoardHandle {
  fit: () => void
  reveal: (canvasId: string) => void
  /** Moves a card just placed at the pointer back inside the view where it sticks out; the view stays put. */
  keepInView: (canvasId: string) => void
}

export interface BoardProps {
  ref?: Ref<BoardHandle>
  projectKey: string
  canvases: ProjectCanvas[]
  selectedCanvasId: string | null
  jobs: readonly JobRecord[]
  busyIds: ReadonlySet<string>
  submitting: boolean
  /** The app update state: a required update blocks reruns (see readiness.ts). */
  update?: ReadinessInput['update']
  tool: BoardTool
  onTool: (tool: BoardTool) => void
  selectedRegionId: string | null
  onSelectRegion: (id: string | null) => void
  onSelectCanvas: (id: string) => void
  onMoveCanvas: (id: string, x: number, y: number) => void
  onChangeLayers: (canvasId: string, update: (layers: ProjectLayer[]) => ProjectLayer[]) => void
  onUnderlay: (item: GalleryItem | null) => void
  /** A new 画面; at a board point when given (the right-click menu). */
  onAddCanvas: (at?: Point) => void
  onOpenViewer: (canvasId: string, index: number) => void
  onRerun: (canvasId: string, seed: 'new' | 'same') => void
  onCancel: (jobId: string) => void
  onShowActivity: (jobId?: string) => void
  onCopy: (canvas: ProjectCanvas) => void
  onDelete: (canvas: ProjectCanvas) => void
  /** Delete several picked cards at once (after asking). */
  onDeleteMany: (ids: string[]) => void
  /** What the engine can do (undefined while loading, null when none is usable). */
  engineFeatures: EngineFeatures | null | undefined
  /** The 生成 footer's readiness: says why the mask tool and the link menu are off while the engine is not ready. */
  blockers: readonly Blocker[]
  controlAdapters: readonly ControlAdapterEntry[]
  onLink: (targetId: string, role: LinkRole, link: CanvasImageLink, kind?: string) => void
  onRemoveLink: (canvasId: string, role: LinkRole, at?: number | string) => void
  /** Picture files dropped or pasted onto the board, at a board point. */
  onImportImages: (files: File[], at: { x: number; y: number }) => void
  /** Model files or folders dropped on the board: they go to 导入模型. */
  onImportModels: (files: File[]) => void
  /** A drop the board cannot use (not a picture, not a model): said out loud, never dropped silently. */
  onRefuseDrop: () => void
  /** A painted mask to store for a canvas (null: nothing painted any more). */
  onSaveMask: (canvasId: string, png: Uint8Array | null) => void
  /** What an empty input slot's menu does (add from the board or a file, choose a control adapter). */
  portActions: PortActions
  /** The model chip of a card: its short name, and whether it is ready to use. */
  describeModel?: (canvas: ProjectCanvas) => { label: string; ready: boolean } | null
  /** Text typed into a card's description on the board. */
  onChangeDescription: (canvasId: string, text: string) => void
  /** Show this filmstrip picture on its 画面's face (and give it to wires from there). */
  onShowOutput: (layoutId: string, link: CanvasImageLink) => void
  /** Pin a filmstrip run as a card of its own: under its 画面, or where it was dragged to. */
  onPinRun: (runId: string, at?: Point) => void
  /** Put a pinned result back into its 画面's filmstrip. */
  onUnpinRun: (runId: string) => void
  /** 用作起始图, or a wire dropped on the empty board: a new 画面 fed by this card's picture. */
  onNewFromPicture: (sourceId: string, role: 'init' | 'reference', at?: Point) => void
  /** 用这次的设置: the 画面 takes back the settings one of its runs was made with. */
  onUseRunSettings: (layoutId: string, runId: string) => void
  /** Remove one run from a 画面's filmstrip. */
  onDropRun: (runId: string) => void
  /** A recipe: a 画面 wired to a picture the user chooses; at a board point when given. */
  onRecipe: (recipe: Recipe, at?: Point) => void
  /** 放大: a 放大 node fed by this card's picture (to its right, or at a board point). */
  onUpscale: (sourceId: string, at?: Point) => void
  /** A new 风格 node; at a board point when given. */
  onAddStyle: (at?: Point) => void
  /** 导入图片… / 从作品选择… from the right-click menu: pictures placed at a board point. */
  onImportPictures: (at: Point) => void
  onPicturesFromGallery: (at: Point) => void
  /**
   * 拆成区域 on a card's picture. `parseBlocker` is undefined while the feature
   * is off (no entry), null when it can run, else why not.
   */
  parseBlocker: string | null | undefined
  onParseRegions: (sourceId: string) => void
  /** 画面 that 拆成区域 is filling, by id. */
  parsing: Readonly<Record<string, ParseView>>
  onStopParse: (canvasId: string) => void
}

/** Things to try on a new board's first 画面. */
const FIRST_IDEAS = ['海边的灯塔，黄昏，暖色调', '窗台上睡觉的橘猫，午后阳光', '雨夜的霓虹街道，电影感'] as const

function worldTransform(view: View): string {
  return `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`
}

function boxStyle(rect: Rect): Partial<CSSStyleDeclaration> {
  return { transform: `translate(${rect.x}px, ${rect.y}px)`, width: `${rect.w}px`, height: `${rect.h}px` }
}

function isTyping(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]'))
}

/** The free-form board: cards placed anywhere and wired together, pan and zoom, and the floating toolbar. */
export function Board(props: BoardProps): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ zoom: 1, pan: { x: FIT_PADDING.side, y: FIT_PADDING.top } })
  /**
   * The view on screen. While the board is dragged it runs ahead of `view`:
   * each move only sets the transform of `world`, and `view` takes the result
   * when the drag ends, so a pan re-renders nothing.
   */
  const viewRef = useRef(view)
  const world = useRef<HTMLDivElement>(null)
  /** Who draws from the live view without re-rendering (the minimap). */
  const viewListeners = useRef(new Set<() => void>())
  const subscribeView = useCallback((listener: () => void) => {
    viewListeners.current.add(listener)
    return () => void viewListeners.current.delete(listener)
  }, [])
  const showView = (next: View): void => {
    viewRef.current = next
    if (world.current) world.current.style.transform = worldTransform(next)
    for (const listener of viewListeners.current) listener()
  }
  const changeView = useCallback((update: View | ((current: View) => View)) => {
    const next = typeof update === 'function' ? update(viewRef.current) : update
    // Written straight away too: React skips the style when it equals the last one it rendered, which a pan may have moved past.
    viewRef.current = next
    if (world.current) world.current.style.transform = worldTransform(next)
    for (const listener of viewListeners.current) listener()
    setView(next)
  }, [])
  const [panning, setPanning] = useState(false)
  const pan = useRef<{
    pointerId: number
    x: number
    y: number
    origin: View['pan']
    /** A right-button pan: a press that does not move still opens the menu. */
    right?: { moved: boolean; target: HTMLElement; menu: { clientX: number; clientY: number } | null }
  } | null>(null)
  /** Space held over the board: a press anywhere pans. */
  const [spaceHeld, setSpaceHeld] = useState(false)
  const overBoard = useRef(false)
  /** After a right-button pan, the menu the button's release would open is not wanted. */
  const menuQuiet = useRef(0)
  const [minimapOn, setMinimapOn] = useState(true)
  const minimapOnRef = useRef(minimapOn)
  minimapOnRef.current = minimapOn
  const [brush, setBrush] = useState<MaskBrush>({ mode: 'paint', size: BRUSH_DEFAULT })
  const [maskCommand, setMaskCommand] = useState<MaskCommand | undefined>(undefined)
  /** Last pointer position over the board, where a pasted picture lands. */
  const pointer = useRef<{ x: number; y: number } | null>(null)

  const selected = props.canvases.find((canvas) => canvas.id === props.selectedCanvasId) ?? null
  // The assistant's plan waiting for 审批, previewed on the selected 画面.
  const planSteps = useShell((state) => state.planPreview)
  const plan = useMemo(
    () => (planSteps && selected?.kind === 'layout' && !selected.upscale ? plannedRegions(selected, planSteps) : []),
    [planSteps, selected],
  )
  // Results folded into a 画面's filmstrip are not cards on the board.
  const folded = useMemo(() => foldedRunIds(props.canvases), [props.canvases])
  /**
   * Cards being dragged (one, or all picked ones), moved by dx, dy: drawn there,
   * and written to the project once, when they are let go.
   */
  const [dragAt, setDragAt] = useState<{ ids: readonly string[]; dx: number; dy: number } | null>(null)
  const onBoard = useMemo(() => boardCanvases(props.canvases, folded), [props.canvases, folded])
  const cards = useMemo(
    () =>
      dragAt
        ? onBoard.map((canvas) =>
            dragAt.ids.includes(canvas.id) ? { ...canvas, x: canvas.x + dragAt.dx, y: canvas.y + dragAt.dy } : canvas,
          )
        : onBoard,
    [onBoard, dragAt],
  )

  /**
   * Cards picked together with the selected one (Shift or Ctrl clicks, a box,
   * Ctrl+A). They count only while they include the selected card, so
   * selecting a card any other way (a new card, the assistant) picks it alone.
   */
  const [group, setGroup] = useState<readonly string[]>([])
  const selection = useMemo(() => {
    const here = new Set(onBoard.map((canvas) => canvas.id))
    const primary = props.selectedCanvasId && here.has(props.selectedCanvasId) ? props.selectedCanvasId : null
    const ids = group.filter((id) => here.has(id))
    if (primary && ids.length > 1 && ids.includes(primary)) return ids
    return primary ? [primary] : []
  }, [group, onBoard, props.selectedCanvasId])
  const multi = selection.length > 1
  /** A box being drawn on the empty board: the cards picked before it (with Shift or Ctrl) and the ones it touches. */
  const [boxPick, setBoxPick] = useState<{ base: readonly string[]; touched: readonly string[] } | null>(null)
  const box = useRef<{
    pointerId: number
    from: Point
    moved: boolean
    base: readonly string[]
    touched: readonly string[]
    /** The box in viewport pixels, kept for the element that appears after the first move. */
    screen?: Rect
  } | null>(null)
  const boxElement = useRef<HTMLDivElement>(null)
  const picked = useMemo(() => new Set(boxPick ? [...boxPick.base, ...boxPick.touched] : selection), [boxPick, selection])

  const [hoveredWire, setHoveredWire] = useState<string | null>(null)
  /** The box whose field is open; `fresh` while it is the one just drawn. */
  const [editingRegion, setEditingRegion] = useState<{ canvasId: string; id: string; fresh: boolean } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ at: { x: number; y: number }; label: string; entries: BoardMenuEntry[] } | null>(null)
  /** The card under the pointer: its wires show their labels, and it shows its ＋. */
  const [hoveredCard, setHoveredCard] = useState<string | null>(null)
  const { engineFeatures, controlAdapters, blockers } = props
  const styleNodes = useMemo(() => props.canvases.filter((canvas) => canvas.kind === 'style'), [props.canvases])
  const hasStyles = styleNodes.length > 0
  const slotsFor = useCallback(
    (canvas: ProjectCanvas) => inputSlots(canvas, engineFeatures, controlAdapters, blockers, hasStyles),
    [engineFeatures, controlAdapters, blockers, hasStyles],
  )
  // Only linked inputs have a port on the card; empty ones are added through the card's ＋.
  const linkedSlotsFor = useCallback((canvas: ProjectCanvas) => slotsFor(canvas).filter((slot) => slot.linked), [slotsFor])
  const ports = useMemo(() => boardPorts(cards, view.zoom, linkedSlotsFor), [cards, view.zoom, linkedSlotsFor])
  const wires = ports.wires
  const slotsForRef = useRef(slotsFor)
  slotsForRef.current = slotsFor
  const mask = maskAvailability(selected, props.engineFeatures, props.blockers)

  const viewportSize = (): { width: number; height: number } => {
    const rect = viewport.current?.getBoundingClientRect()
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 }
  }
  const latest = useRef(props)
  latest.current = props
  const zoomRef = useRef(view.zoom)
  zoomRef.current = view.zoom
  /** The cards a drag moves and where the dragged one started. */
  const dragGroup = useRef<{ ids: readonly string[]; origin: Point }>({ ids: [], origin: { x: 0, y: 0 } })
  // A drag step renders the whole board (wires follow the card), so steps within one frame render once.
  const dragFrame = useRef({ frame: 0, at: null as { ids: readonly string[]; dx: number; dy: number } | null })
  const cardMoveRef = useRef((_id: string, x: number, y: number) => {
    const pending = dragFrame.current
    const { ids, origin } = dragGroup.current
    pending.at = { ids, dx: x - origin.x, dy: y - origin.y }
    if (pending.frame) return
    pending.frame = requestAnimationFrame(() => {
      pending.frame = 0
      setDragAt(pending.at)
    })
  })
  const cardDropRef = useRef((_id: string, x: number, y: number) => {
    cancelAnimationFrame(dragFrame.current.frame)
    dragFrame.current = { frame: 0, at: null }
    setDragAt(null)
    const { ids, origin } = dragGroup.current
    for (const id of ids) {
      const canvas = latest.current.canvases.find((item) => item.id === id)
      if (canvas) latest.current.onMoveCanvas(id, canvas.x + x - origin.x, canvas.y + y - origin.y)
    }
  })
  const cardDrag = useCardDrag({ zoom: zoomRef, onMove: cardMoveRef, onDrop: cardDropRef })
  const callbacks = useStableCallbacks()
  const bind = callbacks.bind
  useEffect(() => callbacks.retain(onBoard.map((canvas) => canvas.id)), [callbacks, onBoard])
  // Reading order on the board; frozen while a card is dragged, because moving
  // its element in the DOM would end the drag (pointer capture is lost).
  const order = useRef<string[]>([])
  const ordered = useMemo(() => {
    const byPosition = [...cards].sort((a, b) => a.y - b.y || a.x - b.x)
    if (!cardDrag.draggingId) {
      order.current = byPosition.map((canvas) => canvas.id)
      return byPosition
    }
    const rank = new Map(order.current.map((id, index) => [id, index]))
    return [...cards].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
  }, [cards, cardDrag.draggingId])
  const orderedRef = useRef(ordered)
  orderedRef.current = ordered
  const connect = useWireConnect({
    viewport,
    view: viewRef,
    cards: orderedRef,
    slotsFor: slotsForRef,
    onSlotDrop: (targetId, sourceId, drop) => latest.current.onLink(targetId, drop.role, { canvasId: sourceId }, drop.kind),
  })
  // An empty slot's menu acts on its card: select it first, as the inputs panel does.
  const portActions: PortActions = {
    ...props.portActions,
    onLinkPicture: (canvasId, role, kind, sourceId) => {
      if (canvasId !== latest.current.selectedCanvasId) latest.current.onSelectCanvas(canvasId)
      latest.current.portActions.onLinkPicture(canvasId, role, kind, sourceId)
    },
    onAddFromFile: (canvasId, role, kind) => {
      if (canvasId !== latest.current.selectedCanvasId) latest.current.onSelectCanvas(canvasId)
      latest.current.portActions.onAddFromFile(canvasId, role, kind)
    },
    onAddFromGallery: (canvasId, role, kind) => {
      if (canvasId !== latest.current.selectedCanvasId) latest.current.onSelectCanvas(canvasId)
      latest.current.portActions.onAddFromGallery(canvasId, role, kind)
    },
  }
  const showRef = useRef((layoutId: string, item: StripItem) =>
    latest.current.onShowOutput(layoutId, item.output ? { canvasId: item.runId, output: item.output } : { canvasId: item.runId }),
  )
  // A thumbnail let go outside its 画面 becomes a card where it was dropped.
  const dropRef = useRef((layoutId: string, item: StripItem, at: Point) => {
    const list = latest.current.canvases
    const layout = list.find((canvas) => canvas.id === layoutId)
    const run = list.find((canvas) => canvas.id === item.runId)
    if (!layout || !run || run.kind !== 'result') return
    const rect = cardRect(layout)
    if (at.x >= rect.x && at.x <= rect.x + rect.w && at.y >= rect.y && at.y <= rect.y + rect.h) return
    latest.current.onPinRun(run.id, { x: at.x - cardWidth(run) / 2, y: at.y - CARD_HEADER / 2 })
  })
  const runDrag = useRunDrag({ viewport, view: viewRef, onShow: showRef, onDrop: dropRef })
  const wireSelection = useWireSelection(wires, (wire) => latest.current.onRemoveLink(wire.targetId, wire.role!, wire.at))
  const selectedWireId = wireSelection.selectedWireId
  const setSelectedWireId = wireSelection.select

  const fit = useCallback(() => {
    const size = viewportSize()
    if (!size.width || !size.height) return
    const list = boardCanvases(latest.current.canvases)
    const choice = list.find((canvas) => canvas.id === latest.current.selectedCanvasId) ?? { width: 1024, height: 1024 }
    const spot = nextFreeSpot(list, choice)
    const extra = { x: spot.x, y: spot.y, w: cardWidth(choice), h: CARD_HEADER + cardBodyHeight(choice) }
    changeView(fitView(size, boardBounds(list, extra), FIT_PADDING))
  }, [changeView])

  const reveal = useCallback(
    (canvasId: string) => {
      const list = latest.current.canvases
      const found = list.find((item) => item.id === canvasId)
      // A run in a filmstrip shows on its 画面.
      const canvas = found && foldedRunIds(list).has(found.id) ? list.find((item) => item.id === found.sourceCanvasId) : found
      const size = viewportSize()
      if (!canvas || !size.width) return
      const rect = cardRect(canvas)
      const current = viewRef.current
      const left = rect.x * current.zoom + current.pan.x
      const top = rect.y * current.zoom + current.pan.y
      const visible =
        left >= 0 && top >= FIT_PADDING.top - 24 && left + rect.w * current.zoom <= size.width && top + rect.h * current.zoom <= size.height
      if (!visible) changeView(centerOn(size, rect, current.zoom))
    },
    [changeView],
  )

  const keepInView = useCallback((canvasId: string) => {
    const canvas = latest.current.canvases.find((item) => item.id === canvasId)
    const size = viewportSize()
    if (!canvas || !size.width) return
    const rect = cardRect(canvas)
    const { zoom, pan } = viewRef.current
    const margin = 16
    // Past the right or bottom edge it moves back; the top-left corner always stays in sight.
    const fit = (value: number, low: number, high: number): number => Math.round(Math.max(low, Math.min(value, high)))
    const top = (FIT_PADDING.top - pan.y) / zoom
    const left = (margin - pan.x) / zoom
    let fx = fit(rect.x, left, (size.width - margin - pan.x) / zoom - rect.w)
    let fy = fit(rect.y, top, (size.height - margin - pan.y) / zoom - rect.h)
    // Nor does it land under the minimap: above it when there is room, otherwise left of it.
    if (minimapOnRef.current) {
      const mapLeft = size.width - MINIMAP_BOX.margin - MINIMAP_BOX.width
      const mapTop = size.height - MINIMAP_BOX.margin - MINIMAP_BOX.height
      const under = fx * zoom + pan.x + rect.w * zoom > mapLeft - margin && fy * zoom + pan.y + rect.h * zoom > mapTop - margin
      if (under) {
        const above = Math.round((mapTop - margin - pan.y) / zoom - rect.h)
        if (above >= top) fy = above
        else fx = Math.max(Math.round(left), Math.round((mapLeft - margin - pan.x) / zoom - rect.w))
      }
    }
    if (fx !== canvas.x || fy !== canvas.y) latest.current.onMoveCanvas(canvas.id, fx, fy)
  }, [])

  useImperativeHandle(props.ref, () => ({ fit, reveal, keepInView }), [fit, reveal, keepInView])

  // Fit once per opened project, as soon as its cards are measurable.
  const fitted = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (fitted.current === props.projectKey || props.canvases.length === 0) return
    fitted.current = props.projectKey
    fit()
  }, [props.projectKey, props.canvases.length, fit])

  // Wheel zooms around the pointer. Ticks within one frame add up and render once:
  // a trackpad or a fast wheel sends several per frame.
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    let frame = 0
    let factor = 1
    let at = { x: 0, y: 0 }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (pan.current) return
      const rect = element.getBoundingClientRect()
      factor *= Math.exp(-event.deltaY * 0.0015)
      at = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const by = factor
        factor = 1
        // A pan that started since keeps its own origin; zooming under it would make the board jump.
        if (pan.current) return
        changeView((current) => zoomAround(current, at.x, at.y, by))
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(frame)
    }
  }, [changeView])

  // Keys for the board: Space pans while held, Ctrl+A picks every card, Delete removes the picked ones,
  // Esc drops the others, F shows everything. A hidden page (another route) or a dialog takes none.
  const keysRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  keysRef.current = (event) => {
    if (!viewport.current?.offsetParent || isTyping(event.target) || document.querySelector('dialog[open]')) return
    const key = event.key.toLowerCase()
    const target = event.target as HTMLElement | null
    if (key === ' ') {
      // A focused control keeps Space for itself (a button presses on it).
      if (target?.closest?.('button, a, summary, [role="button"], [role="menuitem"]')) return
      if (!overBoard.current && !spaceHeld) return
      event.preventDefault()
      if (!spaceHeld) setSpaceHeld(true)
      return
    }
    // The rest only while the board has focus (or nothing has): Ctrl+A in the assistant or the activity panel selects text there.
    if (target && target !== document.body && !viewport.current.contains(target)) return
    if ((event.ctrlKey || event.metaKey) && key === 'a' && !event.altKey) {
      event.preventDefault()
      const ids = readingOrder(onBoard).map((canvas) => canvas.id)
      setGroup(ids)
      if (ids[0] && !ids.includes(props.selectedCanvasId ?? '')) props.onSelectCanvas(ids[0])
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if ((key === 'delete' || key === 'backspace') && !props.selectedRegionId && !selectedWireId && selection.length) {
      event.preventDefault()
      if (multi) props.onDeleteMany(selection)
      else {
        const card = onBoard.find((canvas) => canvas.id === selection[0])
        if (card) props.onDelete(card)
      }
    } else if (key === 'escape' && multi) setGroup([])
    else if (key === 'f') fit()
  }
  useEffect(() => {
    const onDown = (event: KeyboardEvent): void => keysRef.current(event)
    const onUp = (event: KeyboardEvent): void => {
      if (event.key === ' ') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  // With several cards picked, a selected box on one of them would take Delete for itself.
  useEffect(() => {
    if (multi) latest.current.onSelectRegion(null)
  }, [multi])
  // A card selected any other way (a new card, the assistant, a right-click) ends the group,
  // so it cannot come back when an old member is selected again.
  useEffect(() => {
    setGroup((current) => (current.length && !current.includes(props.selectedCanvasId ?? '') ? [] : current))
  }, [props.selectedCanvasId])
  // The minimap's tint follows the board's size too (side panels opening, the window resized).
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      for (const listener of viewListeners.current) listener()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The 遮罩 tool only works on a canvas with a start picture.
  useEffect(() => {
    if (props.tool === 'mask' && !mask.enabled) props.onTool('select')
  }, [props.tool, mask.enabled, props.onTool])

  const zoomBy = (factor: number): void => {
    const size = viewportSize()
    changeView((current) => zoomAround(current, size.width / 2, size.height / 2, factor))
  }

  const endPan = (): void => {
    const gesture = pan.current
    if (!gesture) return
    pan.current = null
    setPanning(false)
    setView(viewRef.current)
    if (viewport.current?.hasPointerCapture(gesture.pointerId)) viewport.current.releasePointerCapture(gesture.pointerId)
    if (!gesture.right) return
    // Where the menu comes on the press (Linux), it waited for the release; where it comes after (Windows), it opens on its own.
    if (gesture.right.moved) menuQuiet.current = performance.now() + 400
    else if (gesture.right.menu) openMenuAt(gesture.right.menu.clientX, gesture.right.menu.clientY, gesture.right.target)
  }

  /** Ends a box: the touched cards join the picked ones; a press that did not move clears them. */
  const endBox = (): void => {
    const gesture = box.current
    if (!gesture) return
    box.current = null
    setBoxPick(null)
    if (viewport.current?.hasPointerCapture(gesture.pointerId)) viewport.current.releasePointerCapture(gesture.pointerId)
    if (!gesture.moved) {
      if (!gesture.base.length) setGroup([])
      return
    }
    const ids = [...new Set([...gesture.base, ...gesture.touched])]
    if (!ids.length) {
      setGroup([])
      return
    }
    const ordered = readingOrder(latest.current.canvases.filter((canvas) => ids.includes(canvas.id))).map((canvas) => canvas.id)
    const primary = latest.current.selectedCanvasId
    setGroup(ordered)
    if (!primary || !ordered.includes(primary)) latest.current.onSelectCanvas(ordered[0]!)
  }
  // Leaving the window ends any gesture: the button may be let go elsewhere.
  const blurRef = useRef(() => undefined as void)
  blurRef.current = () => {
    endPan()
    endBox()
    setSpaceHeld(false)
  }
  useEffect(() => {
    const onBlur = (): void => blurRef.current()
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  const boardPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = viewport.current?.getBoundingClientRect()
    return toBoardPoint(viewRef.current, clientX - (rect?.left ?? 0), clientY - (rect?.top ?? 0))
  }

  const onPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    // Pasting needs the board focused; a press anywhere that is not a control focuses it.
    if (!target.closest('button, input, textarea, select, a, [contenteditable="true"]')) viewport.current?.focus({ preventScroll: true })
    if (!target.closest('[data-wire], [data-wire-chip]')) setSelectedWireId(null)
    if (target.closest('[data-board-ui]') || pan.current || box.current) return
    const onCard = Boolean(target.closest('[data-canvas-card]'))
    // The middle or right button, Space, or the 平移 tool pans; a left drag on the empty board draws a box.
    const wantsPan = event.button === 1 || event.button === 2 || (event.button === 0 && (props.tool === 'pan' || spaceHeld))
    if (wantsPan) {
      event.preventDefault()
      event.stopPropagation()
      pan.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        origin: viewRef.current.pan,
        ...(event.button === 2 ? { right: { moved: false, target, menu: null } } : {}),
      }
      setPanning(event.button !== 2)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0 || onCard) return
    event.preventDefault()
    event.stopPropagation()
    props.onSelectRegion(null)
    const rect = viewport.current!.getBoundingClientRect()
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    box.current = {
      pointerId: event.pointerId,
      from: { x: event.clientX - rect.left, y: event.clientY - rect.top },
      moved: false,
      base: additive ? selection : [],
      touched: [],
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    pointer.current = boardPoint(event.clientX, event.clientY)
    const drawing = box.current
    if (drawing && drawing.pointerId === event.pointerId) {
      if (event.buttons === 0) {
        endBox()
        return
      }
      const rect = viewport.current!.getBoundingClientRect()
      const to = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      if (!drawing.moved && Math.abs(to.x - drawing.from.x) + Math.abs(to.y - drawing.from.y) < 4) return
      if (!drawing.moved) {
        drawing.moved = true
        setBoxPick({ base: drawing.base, touched: [] })
      }
      const screen = boxBetween(drawing.from, to)
      drawing.screen = screen
      if (boxElement.current) Object.assign(boxElement.current.style, boxStyle(screen))
      const { zoom, pan: offset } = viewRef.current
      const touched = cardsInBox(orderedRef.current, {
        x: (screen.x - offset.x) / zoom,
        y: (screen.y - offset.y) / zoom,
        w: screen.w / zoom,
        h: screen.h / zoom,
      })
      // Re-render only when the touched cards change, not on every move.
      if (touched.join() !== drawing.touched.join()) {
        drawing.touched = touched
        setBoxPick({ base: drawing.base, touched })
      }
      return
    }
    const gesture = pan.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (event.buttons === 0) {
      endPan()
      return
    }
    if (gesture.right && !gesture.right.moved) {
      if (Math.abs(event.clientX - gesture.x) + Math.abs(event.clientY - gesture.y) < 4) return
      gesture.right.moved = true
      setPanning(true)
    }
    showView({
      ...viewRef.current,
      pan: { x: gesture.origin.x + event.clientX - gesture.x, y: gesture.origin.y + event.clientY - gesture.y },
    })
  }

  const startCardDrag = (canvas: ProjectCanvas, event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || props.tool === 'pan' || spaceHeld) return
    // A picked card takes the other picked ones along.
    dragGroup.current = { ids: multi && selection.includes(canvas.id) ? selection : [canvas.id], origin: { x: canvas.x, y: canvas.y } }
    cardDrag.start(canvas, event)
  }

  const importFiles = (list: FileList | null | undefined, at: { x: number; y: number }): boolean => {
    const files = [...(list ?? [])].filter(isImageFile)
    if (!files.length) return false
    props.onImportImages(files, at)
    return true
  }

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    if (isTyping(event.target)) return
    const size = viewportSize()
    const at = pointer.current ?? toBoardPoint(viewRef.current, size.width / 2, size.height / 2)
    if (importFiles(event.clipboardData?.files, at)) event.preventDefault()
  }

  const menuSource = connect.menu ? props.canvases.find((canvas) => canvas.id === connect.menu!.sourceId) : undefined

  // 放大 is offered when the engine takes a start picture and the picture can still grow.
  const canUpscale = (canvas: ProjectCanvas): boolean =>
    props.engineFeatures?.imageInput !== false && !upscaleProblem(props.canvases, pictureLink(props.canvases, { canvasId: canvas.id }))
  // 拆成区域 stays in the menu while it cannot run, saying why; choosing it then leads to 设置.
  const parseAction = (canvasId: string): CardMenuAction[] =>
    props.parseBlocker === undefined
      ? []
      : [
          {
            label: '拆成区域',
            hint: props.parseBlocker ?? undefined,
            title: props.parseBlocker ?? undefined,
            disabled: props.parseBlocker === PARSE_CHECKING,
            onSelect: () => props.onParseRegions(canvasId),
          },
        ]
  // The ⋯ menu of a card: what can be done with the picture it shows.
  const cardActions = (canvas: ProjectCanvas, run: ProjectCanvas, item: StripItem | undefined): CardMenuAction[] => {
    const actions: CardMenuAction[] = []
    if (canvas.kind === 'layout') {
      if (!item) return actions
      if (item.path) actions.push({ label: '用作起始图', onSelect: () => props.onNewFromPicture(canvas.id, 'init') })
      if (item.path) actions.push(...parseAction(canvas.id))
      if (item.path && canUpscale(canvas)) actions.push({ label: '放大', onSelect: () => props.onUpscale(canvas.id) })
      if (folded.has(run.id) && item.path) actions.push({ label: '固定到画板', onSelect: () => props.onPinRun(run.id) })
      if (run.kind === 'result') actions.push({ label: '用这次的设置', onSelect: () => props.onUseRunSettings(canvas.id, run.id) })
      // A run that is also a card is deleted from its card.
      if (!isActiveRun(run, props.jobs) && canDropRun(props.canvases, run.id))
        actions.push({ label: '删除这次生成', tone: 'danger', onSelect: () => props.onDropRun(run.id) })
      return actions
    }
    if (givesPicture(canvas, props.canvases)) {
      actions.push({ label: '用作起始图', onSelect: () => props.onNewFromPicture(canvas.id, 'init') })
      actions.push(...parseAction(canvas.id))
      if (canUpscale(canvas)) actions.push({ label: '放大', onSelect: () => props.onUpscale(canvas.id) })
    }
    // A pinned result goes back into its 画面's filmstrip, unless it feeds another canvas.
    if (canUnpin(canvas, props.canvases) && foldedRunIds(unpinRun(props.canvases, canvas.id)).has(canvas.id)) {
      const source = props.canvases.find((item) => item.id === canvas.sourceCanvasId)
      actions.push({ label: `收回到「${source?.title ?? '画面'}」`, onSelect: () => props.onUnpinRun(canvas.id) })
    }
    return actions
  }
  const recipeList = recipes(props.engineFeatures, props.controlAdapters, props.blockers)

  /** The run a card shows: a 画面's picked filmstrip run, or the card itself. */
  const shownOf = (canvas: ProjectCanvas): { run: ProjectCanvas; item: StripItem | undefined } => {
    const film = canvas.kind === 'layout' ? filmstripOf(canvas, props.canvases) : null
    const item = film ? film.items[film.shown] : undefined
    return { run: (item && film?.runs.find((run) => run.id === item.runId)) || canvas, item }
  }

  /** A card's menu, the same under its ⋯ and on right-click. */
  const cardMenu = (canvas: ProjectCanvas, run: ProjectCanvas, item: StripItem | undefined): BoardMenuEntry[] => {
    const actions = cardActions(canvas, run, item)
    const danger = (entry: BoardMenuEntry): boolean => !('gap' in entry) && entry.tone === 'danger'
    const jobId = run.jobId ?? canvas.jobId
    const plain = canvas.kind === 'image' || canvas.kind === 'style'
    return [
      ...actions.filter((entry) => !danger(entry)),
      { label: plain ? '复制' : '复制为新画面', onSelect: () => props.onCopy(canvas) },
      ...(jobId && canvas.kind !== 'image' ? [{ label: '查看详情', onSelect: () => props.onShowActivity(jobId) }] : []),
      { gap: true },
      ...actions.filter(danger),
      {
        label: canvas.kind === 'image' ? '删除' : canvas.kind === 'style' ? '删除风格' : '删除画面',
        tone: 'danger',
        onSelect: () => props.onDelete(canvas),
      },
    ]
  }

  /** Right-click on empty board: make something where the click was. */
  const blankMenu = (point: Point): BoardMenuEntry[] => {
    // New cards put their top-left corner at the click.
    const at = { x: Math.round(point.x), y: Math.round(point.y) }
    const recipeEntry = (recipe: Recipe): BoardMenuEntry => ({
      label: recipe.label,
      disabled: Boolean(recipe.disabled),
      title: recipe.disabled,
      onSelect: () => props.onRecipe(recipe, at),
    })
    return [
      { label: '新建画面', onSelect: () => props.onAddCanvas(at) },
      ...recipeList.filter((recipe) => recipe.role).map(recipeEntry),
      { gap: true },
      { label: '新建风格', onSelect: () => props.onAddStyle(at) },
      ...recipeList.filter((recipe) => !recipe.role).map(recipeEntry),
      { gap: true },
      { label: '导入图片…', onSelect: () => props.onImportPictures(at) },
      { label: '从作品选择…', onSelect: () => props.onPicturesFromGallery(at) },
      { gap: true },
      { label: '显示全部', onSelect: fit },
    ]
  }

  // A box on a 画面: its words, its type, delete.
  const regionMenu = (canvas: ProjectCanvas, region: ProjectLayer): BoardMenuEntry[] => {
    const change = (update: (layer: ProjectLayer) => ProjectLayer | null): void =>
      props.onChangeLayers(canvas.id, (layers) => layers.flatMap((layer) => (layer.id === region.id ? (update(layer) ?? []) : [layer])))
    return [
      { label: '改描述', onSelect: () => setEditingRegion({ canvasId: canvas.id, id: region.id, fresh: false }) },
      { gap: true },
      ...(Object.keys(KIND_LABEL) as ProjectLayerKind[]).map((kind) => ({
        label: KIND_LABEL[kind],
        selected: kind === region.kind,
        onSelect: () => change((layer) => withKind(layer, kind)),
      })),
      { gap: true },
      {
        label: '删除',
        tone: 'danger' as const,
        disabled: region.locked,
        title: region.locked ? '已锁定' : undefined,
        onSelect: () => {
          change(() => null)
          props.onSelectRegion(null)
        },
      },
    ]
  }

  // A new board's only 画面, still blank: it offers a few things to try.
  const firstCanvas = (canvas: ProjectCanvas): boolean =>
    cards.length === 1 &&
    canvas.kind === 'layout' &&
    !canvas.upscale &&
    canvas.layers.length === 0 &&
    !canvas.jobId &&
    !canvas.inputs?.init &&
    !canvas.inputs?.control &&
    !canvas.inputs?.references?.links.length &&
    !canvas.inputs?.styles?.links.length

  /** Shift, Ctrl or ⌘ click: add the card to the picked ones (it becomes the selected one) or take it out. */
  const pickToggle = (id: string): void => {
    const next = toggled(selection, id)
    if (!next.length) return
    setGroup(next)
    if (next.includes(id)) props.onSelectCanvas(id)
    else if (id === props.selectedCanvasId) props.onSelectCanvas(next[next.length - 1]!)
  }

  /** 排整齐: the picked cards in rows, from where the group starts. */
  const tidyPicked = (): void => {
    const places = tidyPlaces(onBoard.filter((canvas) => selection.includes(canvas.id)))
    for (const place of places) props.onMoveCanvas(place.id, place.x, place.y)
  }

  /** The minimap moves the view: centred on a board point, at the same zoom. */
  const centerAt = (point: Point, done: boolean): void => {
    const size = viewportSize()
    const { zoom } = viewRef.current
    const next = { zoom, pan: { x: size.width / 2 - point.x * zoom, y: size.height / 2 - point.y * zoom } }
    if (done) changeView(next)
    else showView(next)
  }

  const openMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    // Text fields keep the system menu (copy, paste).
    if (isTyping(event.target)) return
    event.preventDefault()
    const gesture = pan.current
    if (gesture?.right) {
      // The right button is still down (the menu comes on the press here): it may become a pan.
      gesture.right.menu = { clientX: event.clientX, clientY: event.clientY }
      return
    }
    if (performance.now() < menuQuiet.current) return
    openMenuAt(event.clientX, event.clientY, event.target as HTMLElement)
  }

  const openMenuAt = (clientX: number, clientY: number, target: HTMLElement): void => {
    if (connect.draft) return
    const rect = viewport.current?.getBoundingClientRect()
    const at = { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) }
    const cardId = target.closest<HTMLElement>('article[data-canvas-card]')?.dataset.canvasCard
    const card = cardId ? cards.find((canvas) => canvas.id === cardId) : undefined
    const regionId = target.closest<HTMLElement>('[data-region-id]')?.dataset.regionId
    const region = card && regionId ? card.layers.find((layer) => layer.id === regionId) : undefined
    if (card && region) {
      props.onSelectRegion(region.id)
      setContextMenu({ at, label: '区域', entries: regionMenu(card, region) })
      return
    }
    if (card) {
      if (card.id !== props.selectedCanvasId) props.onSelectCanvas(card.id)
      const { run, item } = shownOf(card)
      setContextMenu({ at, label: `${card.title} 操作`, entries: cardMenu(card, run, item) })
      return
    }
    const wireId =
      target.closest<HTMLElement>('[data-wire]')?.dataset.wire ?? target.closest<HTMLElement>('[data-wire-chip]')?.dataset.wireChip
    const wire = wireId ? wires.find((item) => item.id === wireId && item.kind === 'input') : undefined
    if (wire) {
      setSelectedWireId(wire.id)
      setContextMenu({ at, label: '连线', entries: [{ label: '断开连线', tone: 'danger', onSelect: () => wireSelection.remove(wire) }] })
      return
    }
    // The board's own controls (toolbar, menus) have no menu of their own.
    if (target.closest('[data-board-ui]')) return
    setContextMenu({ at, label: '画板', entries: blankMenu(boardPoint(clientX, clientY)) })
  }
  // Wire labels show for the cards being looked at: the selected one and the one under the pointer.
  const focusIds = new Set([props.selectedCanvasId, hoveredCard].filter((id): id is string => Boolean(id)))
  // The ＋ that adds an input: on the hovered or selected 画面, below its linked inputs.
  // With several cards picked, only the hovered one shows it: the group stays quiet.
  const adderCanvas = connect.draft
    ? undefined
    : cards.find((canvas) => canvas.id === (hoveredCard ?? (multi ? null : props.selectedCanvasId)))
  const adderSlots = adderCanvas?.kind === 'layout' ? slotsFor(adderCanvas).filter((slot) => !slot.linked) : []
  const adderPorts = adderCanvas
    ? wires.filter((wire) => wire.kind === 'input' && wire.targetId === adderCanvas.id).map((wire) => wire.to.y)
    : []
  const adderFor =
    adderCanvas && adderSlots.length
      ? {
          canvas: adderCanvas,
          slots: adderSlots,
          point: {
            x: adderCanvas.x,
            y: adderPorts.length
              ? Math.max(...adderPorts) + 30 / Math.max(0.01, view.zoom)
              : adderCanvas.y + CARD_HEADER + cardBodyHeight(adderCanvas) / 2,
          },
        }
      : null
  const selectedDrawn = selected ? (cards.find((canvas) => canvas.id === selected.id) ?? selected) : null
  const pickedBounds = multi && !boxPick && !connect.draft ? boundsOf(cards.filter((canvas) => selection.includes(canvas.id))) : null
  // An empty project: one blank 画面, with the ways to start from a picture under it.
  const only = cards.length === 1 ? cards[0]! : null
  const startFor =
    only && only.kind === 'layout' && !only.inputs && !only.jobState && !only.outputs?.length && !runsOf(only, props.canvases).length
      ? only
      : null
  const dragged = runDrag.drag
  // While a wire is out, cards that can take it show their sockets; their linked inputs' thumbnails and labels step aside.
  const offers = connect.draft?.offers
  const labelled = offers ? wires.filter((wire) => wire.kind !== 'input' || !offers.has(wire.targetId)) : wires

  return (
    <div
      ref={viewport}
      tabIndex={-1}
      data-board
      data-panning={panning || undefined}
      className={cn(
        'relative h-full min-h-0 overflow-hidden bg-board outline-none',
        (panning || spaceHeld || props.tool === 'pan') && 'cursor-grab',
        panning && 'cursor-grabbing',
      )}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        endPan()
        endBox()
      }}
      onPointerCancel={() => {
        endPan()
        endBox()
      }}
      onLostPointerCapture={(event) => {
        if (pan.current?.pointerId === event.pointerId) endPan()
        if (box.current?.pointerId === event.pointerId) endBox()
      }}
      onPointerEnter={() => {
        overBoard.current = true
      }}
      onPointerLeave={() => {
        overBoard.current = false
      }}
      onAuxClick={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return
        // The board answers every file drag itself, so the window's import layer stays away; what it cannot take shows no copy cursor.
        event.preventDefault()
        const types = [...event.dataTransfer.items].filter((item) => item.kind === 'file').map((item) => item.type)
        event.dataTransfer.dropEffect = boardTakesDrag(types) ? 'copy' : 'none'
      }}
      onDrop={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return
        event.preventDefault()
        const entries = [...event.dataTransfer.items].filter((item) => item.kind === 'file')
        const files = [...event.dataTransfer.files].map((file, index) => ({
          file,
          type: file.type,
          name: file.name,
          folder: Boolean(entries[index]?.webkitGetAsEntry()?.isDirectory),
        }))
        const { images, models, other } = sortBoardDrop(files)
        if (images.length)
          props.onImportImages(
            images.map((item) => item.file),
            boardPoint(event.clientX, event.clientY),
          )
        if (models.length) props.onImportModels(models.map((item) => item.file))
        if (other.length) props.onRefuseDrop()
      }}
      onPaste={onPaste}
      onContextMenu={openMenu}
    >
      <Toolbar
        tool={props.tool}
        onTool={props.onTool}
        zoom={view.zoom}
        onZoom={zoomBy}
        onFit={fit}
        minimap={minimapOn}
        onMinimap={setMinimapOn}
      />
      {props.tool === 'mask' && mask.enabled ? (
        <MaskBar
          brush={brush}
          onBrush={setBrush}
          onClear={() => setMaskCommand((value) => ({ type: 'clear', n: (value?.n ?? 0) + 1 }))}
          onInvert={() => setMaskCommand((value) => ({ type: 'invert', n: (value?.n ?? 0) + 1 }))}
          onDone={() => props.onTool('select')}
        />
      ) : null}

      <div
        ref={world}
        className="absolute left-0 top-0 origin-top-left"
        // Read from the ref: during a pan it is ahead of `view` (see viewRef).
        // --board-unscale keeps on-card controls at screen size without re-rendering the cards on zoom.
        style={{ transform: worldTransform(viewRef.current), '--board-unscale': 1 / Math.max(0.01, view.zoom) } as React.CSSProperties}
      >
        <WireLayer
          wires={wires}
          zoom={view.zoom}
          selectedWireId={selectedWireId}
          selectedCanvasId={props.selectedCanvasId}
          flowing={props.busyIds}
          draft={connect.draft}
          onSelect={(id) => {
            setSelectedWireId(id)
            props.onSelectRegion(null)
          }}
          onHover={setHoveredWire}
        />
        {ordered.map((canvas) => {
          const viewOf = (run: ProjectCanvas): CardJobView =>
            cardJobView(run, run.jobId ? props.jobs.find((item) => item.id === run.jobId) : undefined, props.jobs)
          // A 画面 shows the run picked in its filmstrip: its picture, progress and job.
          const film = canvas.kind === 'layout' ? filmstripOf(canvas, props.canvases) : null
          const item = film ? film.items[film.shown] : undefined
          const shownRun = (item && film?.runs.find((run) => run.id === item.runId)) || canvas
          const views = new Map<string, CardJobView>(film?.runs.map((run) => [run.id, viewOf(run)]) ?? [])
          const jobId = shownRun.jobId
          // The card keeps the same functions across renders; each calls this render's closure (see useStableCallbacks).
          const on = bind(canvas.id, {
            hover: (hovering: boolean) => setHoveredCard((current) => (hovering ? canvas.id : current === canvas.id ? null : current)),
            menuSelect: (label: string) => {
              const entry = cardMenu(canvas, shownRun, item).find((option) => !('gap' in option) && option.label === label)
              if (entry && !('gap' in entry) && !entry.disabled) entry.onSelect()
            },
            stripShow: (index: number) => showRef.current(canvas.id, film!.items[index]!),
            stripOpen: (index: number) => props.onOpenViewer(film!.items[index]!.runId, film!.items[index]!.output),
            stripPointerDown: (index: number, event: React.PointerEvent<HTMLButtonElement>) =>
              runDrag.start(canvas.id, film!.items[index]!, event),
            saveMask: (png: Uint8Array | null) => props.onSaveMask(canvas.id, png),
            changeDescription: (text: string) => props.onChangeDescription(canvas.id, text),
            stopParse: () => props.onStopParse(canvas.id),
            portDown: (event: React.PointerEvent<HTMLElement>) => connect.start(canvas, event),
            select: (keys?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
              if (cardDrag.isDragTail()) return
              if (keys && (keys.shiftKey || keys.ctrlKey || keys.metaKey)) {
                pickToggle(canvas.id)
                return
              }
              setGroup([])
              if (canvas.id !== props.selectedCanvasId) props.onSelectCanvas(canvas.id)
            },
            selectRegion: (id: string | null) => props.onSelectRegion(id),
            changeLayers: (update: (layers: ProjectLayer[]) => ProjectLayer[]) => props.onChangeLayers(canvas.id, update),
            regionDrawn: (id: string) => {
              props.onSelectRegion(id)
              setEditingRegion({ canvasId: canvas.id, id, fresh: true })
            },
            editRegion: (id: string) => {
              props.onSelectRegion(id)
              setEditingRegion({ canvasId: canvas.id, id, fresh: false })
            },
            editDone: (cancel: boolean) => {
              const editing = editingRegion
              setEditingRegion(null)
              if (!cancel || !editing?.fresh) return
              // Esc on a box just drawn and still empty takes it back.
              const layer = canvas.layers.find((entry) => entry.id === editing.id)
              if (layer && !layer.caption.trim() && !layer.text?.trim()) {
                props.onChangeLayers(canvas.id, (layers) => layers.filter((entry) => entry.id !== editing.id))
                props.onSelectRegion(null)
              }
            },
            dragStart: (event: React.PointerEvent<HTMLElement>) => startCardDrag(canvas, event),
            openViewer: (index: number) => {
              // Letting go of a moved card is not a click on its picture.
              if (!cardDrag.isDragTail()) props.onOpenViewer(shownRun.id, index)
            },
            rerun: (seed: 'new' | 'same') => props.onRerun(canvas.id, seed),
            cancel: () => {
              if (jobId) props.onCancel(jobId)
            },
            showActivity: () => props.onShowActivity(jobId),
          })
          const strip: CardStrip | null =
            film && item
              ? {
                  items: film.items,
                  shown: film.shown,
                  views,
                  onShow: on.stripShow,
                  onOpen: on.stripOpen,
                  onPointerDown: on.stripPointerDown,
                }
              : null
          const busy = props.busyIds.has(canvas.id)
          // With several picked, none of them is the one being edited: a drag on any face moves them all.
          const isSelected = canvas.id === props.selectedCanvasId && !multi
          const init = canvas.kind === 'layout' ? canvas.inputs?.init : undefined
          const initPath = init ? linkSourceImage(init.link, props.canvases) : null
          const showMask = Boolean(init && isSelected && (props.tool === 'mask' || canvas.inputs?.mask))
          const draft = connect.draft
          const offer = draft?.offers.get(canvas.id)
          const aimed = offer && draft?.targetId === canvas.id ? draft.zones : undefined
          // While a wire is out, cards that cannot take it step back.
          const inert = Boolean(draft && canvas.id !== draft.sourceId && !offer)
          return (
            <CanvasCard
              key={canvas.id}
              onHoverChange={on.hover}
              inert={inert}
              canvas={canvas}
              view={views.get(shownRun.id) ?? viewOf(shownRun)}
              strip={strip}
              jobId={jobId}
              menu={cardMenu(canvas, shownRun, item).map((entry) => {
                if ('gap' in entry) return entry
                const { onSelect: _onSelect, ...shown } = entry
                return shown
              })}
              onMenuSelect={on.menuSelect}
              // While a box is drawn, only the cards it will pick are ringed.
              selected={isSelected && (!boxPick || picked.has(canvas.id))}
              marked={picked.has(canvas.id)}
              dragging={cardDrag.draggingId === canvas.id}
              tool={props.tool}
              selectedRegionId={props.selectedRegionId}
              editingRegionId={editingRegion?.canvasId === canvas.id ? editingRegion.id : null}
              planned={isSelected && plan.length ? plan : undefined}
              rerun={rerunEligibility(canvas, { busy, submitting: props.submitting, update: props.update })}
              initPicture={initPath ? { path: initPath, resize: init?.resize, size: startPictureSize(canvas, props.canvases) } : null}
              mask={
                showMask
                  ? {
                      interactive: props.tool === 'mask' && mask.enabled,
                      brush,
                      command: maskCommand,
                      onSave: on.saveMask,
                    }
                  : null
              }
              // A 风格 always offers its wire; a picture card once it has a picture.
              hasOutput={canvas.kind === 'style' || givesPicture(canvas, props.canvases)}
              styleUsers={
                canvas.kind === 'style'
                  ? props.canvases.filter(
                      (item) => item.kind === 'layout' && item.inputs?.styles?.links.some((link) => link.canvasId === canvas.id),
                    ).length
                  : undefined
              }
              model={canvas.kind === 'layout' ? (props.describeModel?.(canvas) ?? null) : null}
              onChangeDescription={on.changeDescription}
              ideas={firstCanvas(canvas) && !(isSelected && plan.length) ? FIRST_IDEAS : undefined}
              dropZones={
                offer
                  ? {
                      items: offer.slots.map((slot, index) => {
                        const drop = offer.drops[index]!
                        const y = socketY(canvas, index, offer.slots.length, view.zoom) - canvas.y - CARD_HEADER
                        return { label: slot.label, role: slot.role, ok: drop.ok, reason: drop.ok ? undefined : drop.reason, y }
                      }),
                      active: aimed ? aimed.active : -1,
                      scale: 1 / Math.max(0.01, view.zoom),
                      ghost: aimed && draft?.ok ? linkSourceImage({ canvasId: draft.sourceId }, props.canvases) : null,
                    }
                  : undefined
              }
              parsing={props.parsing[canvas.id]}
              onStopParse={on.stopParse}
              connecting={Boolean(draft && canvas.id !== draft.sourceId)}
              wireOut={draft?.sourceId === canvas.id}
              onPortDown={on.portDown}
              onSelect={on.select}
              onSelectRegion={on.selectRegion}
              onChangeLayers={on.changeLayers}
              onRegionDrawn={on.regionDrawn}
              onEditRegion={on.editRegion}
              onEditDone={on.editDone}
              onDragStart={on.dragStart}
              onOpenViewer={on.openViewer}
              onRerun={on.rerun}
              onCancel={on.cancel}
              onShowActivity={on.showActivity}
            />
          )
        })}
        <InputThumbs wires={labelled} canvases={props.canvases} zoom={view.zoom} />
        {selected && selected.kind === 'layout' && !selected.upscale && !connect.draft && !multi ? (
          // A 画面's tools sit on the selected card, above its title.
          <div
            className="absolute left-0 top-0 z-[7] origin-top-left"
            style={{
              // Where the card is drawn, which leads the project while it is dragged.
              transform: `translate(${selectedDrawn!.x}px, ${selectedDrawn!.y}px) scale(${1 / Math.max(0.01, view.zoom)}) translate(0, calc(-100% - 6px))`,
            }}
          >
            <CardToolbar
              tool={props.tool}
              onTool={props.onTool}
              underlay={selected.backgroundPath}
              onUnderlay={props.onUnderlay}
              mask={mask}
            />
          </div>
        ) : null}
        <WireChips
          wires={labelled}
          zoom={view.zoom}
          focus={focusIds}
          selectedWireId={selectedWireId}
          hovered={hoveredWire}
          onHover={setHoveredWire}
          onSelect={(id) => {
            setSelectedWireId(id)
            props.onSelectRegion(null)
          }}
          onRemove={wireSelection.remove}
        />
        {adderFor ? (
          <InputAdder
            canvasId={adderFor.canvas.id}
            title={adderFor.canvas.title}
            slots={adderFor.slots}
            point={adderFor.point}
            zoom={view.zoom}
            adapters={props.controlAdapters}
            styles={styleNodes}
            canvases={props.canvases}
            actions={portActions}
            onHoverChange={(on: boolean) =>
              setHoveredCard((current) => (on ? adderFor.canvas.id : current === adderFor.canvas.id ? null : current))
            }
          />
        ) : null}
        {/* A refusal that is not a drop zone's (a zone says its own) shows by the pointer. */}
        {connect.draft && !connect.draft.ok && connect.draft.reason && !connect.draft.zones ? (
          <div
            role="status"
            data-wire-refused
            className="pointer-events-none absolute left-0 top-0 z-[7] origin-top-left whitespace-nowrap rounded-full bg-raised px-2.5 py-1 text-caption text-ink shadow-float"
            style={{
              transform: `translate(${connect.draft.to.x}px, ${connect.draft.to.y}px) scale(${1 / Math.max(0.01, view.zoom)}) translate(12px, 12px)`,
            }}
          >
            {connect.draft.reason}
          </div>
        ) : null}
        {pickedBounds ? (
          <SelectionBar
            point={{ x: pickedBounds.x + pickedBounds.w / 2, y: pickedBounds.y }}
            zoom={view.zoom}
            count={selection.length}
            onTidy={tidyPicked}
            onDelete={() => props.onDeleteMany(selection)}
          />
        ) : null}
        {startFor ? (
          <StartRow
            point={{ x: startFor.x, y: startFor.y + cardRect(startFor).h + 12 / view.zoom }}
            zoom={view.zoom}
            recipes={recipeList}
            onRecipe={props.onRecipe}
          />
        ) : null}
        {dragged?.item.path ? (
          <div
            aria-hidden="true"
            data-run-drag
            className="pointer-events-none absolute left-0 top-0 z-[8] size-16 origin-top-left overflow-hidden rounded-md bg-well-strong shadow-float"
            style={{
              transform: `translate(${dragged.at.x}px, ${dragged.at.y}px) scale(${1 / Math.max(0.01, view.zoom)}) translate(-50%, -50%)`,
            }}
          >
            <OutputImage path={dragged.item.path} alt="" />
          </div>
        ) : null}
      </div>

      {boxPick ? (
        // The box being drawn: a tint, no outline (see ui-rules). Moved by onPointerMove without a render.
        <div
          ref={(element) => {
            boxElement.current = element
            if (element && box.current?.screen) Object.assign(element.style, boxStyle(box.current.screen))
          }}
          aria-hidden="true"
          data-select-box
          className="pointer-events-none absolute left-0 top-0 z-[8] rounded-[4px] bg-accent-soft"
        />
      ) : null}
      {minimapOn ? (
        <Minimap
          cards={cards}
          pictureOf={(id) => linkSourceImage({ canvasId: id }, props.canvases)}
          picked={picked}
          busy={props.busyIds}
          view={() => viewRef.current}
          subscribe={subscribeView}
          boardSize={viewportSize}
          onCenter={centerAt}
        />
      ) : null}
      {contextMenu ? (
        <BoardMenu
          label={contextMenu.label}
          entries={contextMenu.entries}
          at={contextMenu.at}
          bounds={viewportSize()}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      {connect.menu ? (
        <LinkMenu
          title={`用「${menuSource?.title ?? '图片'}」新建画面`}
          entries={newCanvasMenu(props.engineFeatures, props.blockers)}
          at={connect.menu.at}
          bounds={viewportSize()}
          onClose={connect.closeMenu}
          onPick={(role, kind) => {
            const menu = connect.menu!
            const at = { x: menu.point.x, y: menu.point.y - CARD_HEADER }
            if (kind === 'upscale') props.onUpscale(menu.sourceId, at)
            else if (role === 'init' || role === 'reference') props.onNewFromPicture(menu.sourceId, role, at)
            connect.closeMenu()
          }}
        />
      ) : null}
      <span className="sr-only" aria-live="polite">
        {selectedWireId ? `已选中连线 ${wires.find((wire) => wire.id === selectedWireId)?.label ?? ''}，按 Delete 断开` : ''}
      </span>
    </div>
  )
}
