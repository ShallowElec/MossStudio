import { z } from 'zod'

/**
 * 分格: how a page is cut into panels. A page's `frames` is a split tree: a
 * leaf is one panel, a split cuts its area in two, across (`y`, top and
 * bottom) or down (`x`), less one gutter. A cut may slant: its far end sits
 * `slant` further along than its near end, so every panel is a convex
 * quadrilateral. A panel against the edge of the drawable area can bleed off
 * the paper.
 *
 * The tree is kept in reading order, not on-screen order: a split's `first`
 * is read first, so the leaves in tree order are the page's panels in order.
 * Geometry is worked out with `first` on the left and mirrored when the page
 * reads right to left, so turning the reading direction mirrors the page and
 * keeps every panel's content.
 *
 * The split tree, slanted gutters, bleed and the limits below follow the
 * 漫画分镜工作台 of Penna (https://github.com/storyAura/Penna,
 * lib/core/harness/manga), MIT License, Copyright (c) 2026 storyAura.
 */

/** A manga page is 182 × 257 mm (B5); pages are drawn at this pixel size, 8 px a millimetre. */
export const PAGE_WIDTH = 1456
export const PAGE_HEIGHT = 2056
export const PAGE_MARGIN = 72
export const PANEL_GUTTER = 24
/** A panel's narrowest side, 15 mm. */
export const MIN_PANEL_SIDE = 120
/** How far a bleeding panel runs past the paper edge, so no paper shows when the page is trimmed. */
export const BLEED_OVERRUN = 24
/** How far a cut may slant: its two ends differ by at most this share of the length. */
export const MAX_SLANT = 0.3
/** Panels one page holds at most (the document's limit). */
export const MAX_FRAME_PANELS = 12

export type FrameAxis = 'x' | 'y'
export interface FrameLeaf {
  kind: 'panel'
  bleed?: boolean
}
export interface FrameSplit {
  kind: 'split'
  axis: FrameAxis
  /** The first part's share of the usable length (less the gutter), measured along the near edge. */
  ratio: number
  /** The far end sits this much further along than the near end; absent or 0 is straight. */
  slant?: number
  first: FrameNode
  second: FrameNode
}
export type FrameNode = FrameLeaf | FrameSplit

const leafSchema = z.object({ kind: z.literal('panel'), bleed: z.boolean().optional() })
export const frameNodeSchema: z.ZodType<FrameNode> = z.lazy(() =>
  z.union([
    leafSchema,
    z
      .object({
        kind: z.literal('split'),
        axis: z.enum(['x', 'y']),
        ratio: z.number().gt(0).lt(1),
        slant: z.number().min(-MAX_SLANT).max(MAX_SLANT).optional(),
        first: frameNodeSchema,
        second: frameNodeSchema,
      })
      .refine((split) => split.ratio + (split.slant ?? 0) > 0 && split.ratio + (split.slant ?? 0) < 1, 'cut runs off its panel'),
  ]),
)

export interface Point {
  x: number
  y: number
}
/** Top left, top right, bottom right, bottom left. */
export type Quad = [Point, Point, Point, Point]
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const panel = (bleed = false): FrameLeaf => (bleed ? { kind: 'panel', bleed: true } : { kind: 'panel' })
export const split = (axis: FrameAxis, ratio: number, first: FrameNode, second: FrameNode, slant = 0): FrameSplit =>
  slant ? { kind: 'split', axis, ratio, slant, first, second } : { kind: 'split', axis, ratio, first, second }

export function leafCount(node: FrameNode): number {
  return node.kind === 'panel' ? 1 : leafCount(node.first) + leafCount(node.second)
}

/** A node's place in the tree: '' is the root, then '0' for `first` and '1' for `second` at each level. */
export type FramePath = string

export function leafPaths(node: FrameNode, at: FramePath = ''): FramePath[] {
  return node.kind === 'panel' ? [at] : [...leafPaths(node.first, `${at}0`), ...leafPaths(node.second, `${at}1`)]
}

export function nodeAt(root: FrameNode, path: FramePath): FrameNode | undefined {
  let node: FrameNode = root
  for (const step of path) {
    if (node.kind !== 'split') return undefined
    node = step === '0' ? node.first : node.second
  }
  return node
}

export function replaceAt(root: FrameNode, path: FramePath, change: (node: FrameNode) => FrameNode): FrameNode {
  if (!path) return change(root)
  if (root.kind !== 'split') return root
  const rest = path.slice(1)
  return path[0] === '0'
    ? { ...root, first: replaceAt(root.first, rest, change) }
    : { ...root, second: replaceAt(root.second, rest, change) }
}

const content = (): Quad => {
  const right = PAGE_WIDTH - PAGE_MARGIN
  const bottom = PAGE_HEIGHT - PAGE_MARGIN
  return [
    { x: PAGE_MARGIN, y: PAGE_MARGIN },
    { x: right, y: PAGE_MARGIN },
    { x: right, y: bottom },
    { x: PAGE_MARGIN, y: bottom },
  ]
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/**
 * One cut: along the near edge (the left edge for a cut across, the top edge for a cut down) at `ratio`, along the
 * far edge at `ratio + slant`, each less one gutter. Returns both parts and the gutter's centre line.
 */
export function cutQuad(q: Quad, node: FrameSplit, gap = PANEL_GUTTER): { first: Quad; second: Quad; a: Point; b: Point } {
  const across = node.axis === 'y'
  const [s0, e0, s1, e1] = across ? [q[0], q[3], q[1], q[2]] : [q[0], q[1], q[3], q[2]]
  const at = (from: Point, to: Point, ratio: number): [Point, Point] => {
    const length = across ? to.y - from.y : to.x - from.x
    if (length <= 0) return [from, from]
    const start = (length - gap) * ratio
    return [lerp(from, to, start / length), lerp(from, to, (start + gap) / length)]
  }
  const [a0, b0] = at(s0, e0, node.ratio)
  const [a1, b1] = at(s1, e1, node.ratio + (node.slant ?? 0))
  return across
    ? { first: [q[0], q[1], a1, a0], second: [b0, b1, q[2], q[3]], a: mid(a0, b0), b: mid(a1, b1) }
    : { first: [q[0], a0, a1, q[3]], second: [b0, q[1], q[2], b1], a: mid(a0, b0), b: mid(a1, b1) }
}

const mirrorPoint = (p: Point): Point => ({ x: PAGE_WIDTH - p.x, y: p.y })
/** Mirrored left to right, still listed top left, top right, bottom right, bottom left. */
const mirrorQuad = (q: Quad): Quad => [mirrorPoint(q[1]), mirrorPoint(q[0]), mirrorPoint(q[3]), mirrorPoint(q[2])]

const EDGE = 0.5
function bleedQuad(q: Quad): Quad {
  const right = PAGE_WIDTH - PAGE_MARGIN
  const bottom = PAGE_HEIGHT - PAGE_MARGIN
  const push = (p: Point): Point => ({
    x: p.x <= PAGE_MARGIN + EDGE ? -BLEED_OVERRUN : p.x >= right - EDGE ? PAGE_WIDTH + BLEED_OVERRUN : p.x,
    y: p.y <= PAGE_MARGIN + EDGE ? -BLEED_OVERRUN : p.y >= bottom - EDGE ? PAGE_HEIGHT + BLEED_OVERRUN : p.y,
  })
  return q.map(push) as Quad
}

export type ReadingDirection = 'rtl' | 'ltr'

/**
 * Every panel's quadrilateral on the page, in reading order. `bleed` pushes a bleeding panel's corners on the edge
 * of the drawable area past the paper; without it, the frames are the ones inside the margins.
 */
export function panelQuads(frames: FrameNode, direction: ReadingDirection, options: { bleed?: boolean } = {}): Quad[] {
  const out: Quad[] = []
  const walk = (node: FrameNode, q: Quad): void => {
    if (node.kind === 'panel') {
      const shaped = options.bleed && node.bleed ? bleedQuad(q) : q
      out.push(direction === 'rtl' ? mirrorQuad(shaped) : shaped)
      return
    }
    const cut = cutQuad(q, node)
    walk(node.first, cut.first)
    walk(node.second, cut.second)
  }
  walk(frames, content())
  return out
}

export function boundsOf(q: Quad): Rect {
  const xs = q.map((p) => p.x)
  const ys = q.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** The largest upright rectangle the edges allow without crossing a slanted one; balloons are placed in it. */
export function innerRect(q: Quad): Rect {
  const left = Math.max(q[0].x, q[3].x)
  const right = Math.min(q[1].x, q[2].x)
  const top = Math.max(q[0].y, q[1].y)
  const bottom = Math.min(q[3].y, q[2].y)
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) }
}

/** The quadrilateral's narrowest width and height (the shorter of each pair of opposite edges). */
export function spanOf(q: Quad): { w: number; h: number } {
  return {
    w: Math.min(Math.abs(q[1].x - q[0].x), Math.abs(q[2].x - q[3].x)),
    h: Math.min(Math.abs(q[3].y - q[0].y), Math.abs(q[2].y - q[1].y)),
  }
}

/** Area in square pixels (shoelace). */
export function areaOf(q: Quad): number {
  let twice = 0
  for (let i = 0; i < 4; i += 1) {
    const a = q[i]!
    const b = q[(i + 1) % 4]!
    twice += a.x * b.y - b.x * a.y
  }
  return Math.abs(twice) / 2
}

/** How wide and tall a subtree must be so every panel keeps its narrowest side. */
function need(node: FrameNode, gap = PANEL_GUTTER): { w: number; h: number } {
  if (node.kind === 'panel') return { w: MIN_PANEL_SIDE, h: MIN_PANEL_SIDE }
  const a = need(node.first, gap)
  const b = need(node.second, gap)
  return node.axis === 'x' ? { w: a.w + gap + b.w, h: Math.max(a.h, b.h) } : { w: Math.max(a.w, b.w), h: a.h + gap + b.h }
}

/** True when every panel keeps its narrowest side. */
export function framesFit(frames: FrameNode): boolean {
  return panelQuads(frames, 'ltr').every((q) => {
    const span = spanOf(q)
    return span.w >= MIN_PANEL_SIDE - EDGE && span.h >= MIN_PANEL_SIDE - EDGE
  })
}

/** A gutter that can be dragged: the split's path, its axis and the gutter's centre line on the page. */
export interface FrameHandle {
  path: FramePath
  axis: FrameAxis
  a: Point
  b: Point
}

export function frameHandles(frames: FrameNode, direction: ReadingDirection): FrameHandle[] {
  const out: FrameHandle[] = []
  const walk = (node: FrameNode, q: Quad, path: FramePath): void => {
    if (node.kind !== 'split') return
    const cut = cutQuad(q, node)
    const flip = direction === 'rtl' ? mirrorPoint : (p: Point) => p
    out.push({ path, axis: node.axis, a: flip(cut.a), b: flip(cut.b) })
    walk(node.first, cut.first, `${path}0`)
    walk(node.second, cut.second, `${path}1`)
  }
  walk(frames, content(), '')
  return out
}

function parentQuad(frames: FrameNode, path: FramePath): Quad | undefined {
  let node: FrameNode = frames
  let q = content()
  for (const step of path) {
    if (node.kind !== 'split') return undefined
    const cut = cutQuad(q, node)
    q = step === '0' ? cut.first : cut.second
    node = step === '0' ? node.first : node.second
  }
  return q
}

/** The ratios `node` may take inside `q` so both sides keep room for their panels; undefined when nothing fits. */
function ratioRange(q: Quad, node: FrameSplit, gap = PANEL_GUTTER): { lo: number; hi: number } | undefined {
  const across = node.axis === 'y'
  const a = need(node.first, gap)
  const b = need(node.second, gap)
  const needA = across ? a.h : a.w
  const needB = across ? b.h : b.w
  const slant = node.slant ?? 0
  const edges: Array<[number, number]> = across
    ? [
        [q[3].y - q[0].y, 0],
        [q[2].y - q[1].y, slant],
      ]
    : [
        [q[1].x - q[0].x, 0],
        [q[2].x - q[3].x, slant],
      ]
  let lo = 0.001
  let hi = 0.999
  for (const [length, offset] of edges) {
    const usable = length - gap
    if (usable <= 0) return undefined
    lo = Math.max(lo, needA / usable - offset)
    hi = Math.min(hi, 1 - needB / usable - offset)
  }
  return lo > hi ? undefined : { lo, hi }
}

/**
 * Drag a gutter: `point` is where the pointer is on the page; the gutter's middle moves there along its axis and
 * keeps its slant, clamped so every panel keeps its narrowest side. Undefined when it cannot move at all.
 */
export function dragGutter(frames: FrameNode, path: FramePath, point: Point, direction: ReadingDirection): FrameNode | undefined {
  const node = nodeAt(frames, path)
  const q = parentQuad(frames, path)
  if (!node || node.kind !== 'split' || !q) return undefined
  const range = ratioRange(q, node)
  if (!range) return undefined
  const box = boundsOf(q)
  const down = node.axis === 'x'
  const usable = (down ? box.w : box.h) - PANEL_GUTTER
  if (usable <= 0) return undefined
  const along = down ? (direction === 'rtl' ? PAGE_WIDTH - point.x : point.x) : point.y
  const want = along - (down ? box.x : box.y) - PANEL_GUTTER / 2
  const ratio = Math.min(range.hi, Math.max(range.lo, want / usable - (node.slant ?? 0) / 2))
  return replaceAt(frames, path, () => ({ ...node, ratio }))
}

/** Panel `index` cut in half; the new panel comes right after it in reading order. Undefined when it has no room. */
export function splitFrame(frames: FrameNode, index: number, axis: FrameAxis): FrameNode | undefined {
  const path = leafPaths(frames)[index]
  const q = panelQuads(frames, 'ltr')[index]
  if (path === undefined || !q) return undefined
  const span = spanOf(q)
  if ((axis === 'x' ? span.w : span.h) < 2 * MIN_PANEL_SIDE + PANEL_GUTTER) return undefined
  return replaceAt(frames, path, (leaf) => split(axis, 0.5, leaf, panel()))
}

/** The panel cut from the same split as panel `index`, when that is a single panel too; undefined otherwise. */
export function mergeableWith(frames: FrameNode, index: number): number | undefined {
  const paths = leafPaths(frames)
  const path = paths[index]
  if (!path) return undefined
  const sibling = `${path.slice(0, -1)}${path.endsWith('0') ? '1' : '0'}`
  const other = paths.indexOf(sibling)
  return other >= 0 ? other : undefined
}

/** Panel `index` and its sibling made one panel again, where the first of the two was. */
export function mergeFrame(frames: FrameNode, index: number): FrameNode | undefined {
  if (mergeableWith(frames, index) === undefined) return undefined
  const path = leafPaths(frames)[index]!
  const parent = nodeAt(frames, path.slice(0, -1))
  if (!parent || parent.kind !== 'split') return undefined
  const bleed = (parent.first.kind === 'panel' && parent.first.bleed) || (parent.second.kind === 'panel' && parent.second.bleed)
  return replaceAt(frames, path.slice(0, -1), () => panel(Boolean(bleed)))
}

export function isBleed(frames: FrameNode, index: number): boolean {
  const path = leafPaths(frames)[index]
  const node = path === undefined ? undefined : nodeAt(frames, path)
  return node?.kind === 'panel' && Boolean(node.bleed)
}

export function setBleed(frames: FrameNode, index: number, bleed: boolean): FrameNode {
  const path = leafPaths(frames)[index]
  return path === undefined ? frames : replaceAt(frames, path, () => panel(bleed))
}

/** True when panel `index` touches the edge of the drawable area, so bleeding would change it. */
export function touchesEdge(frames: FrameNode, index: number): boolean {
  const q = panelQuads(frames, 'ltr')[index]
  if (!q) return false
  const right = PAGE_WIDTH - PAGE_MARGIN
  const bottom = PAGE_HEIGHT - PAGE_MARGIN
  return q.some((p) => p.x <= PAGE_MARGIN + EDGE || p.y <= PAGE_MARGIN + EDGE || p.x >= right - EDGE || p.y >= bottom - EDGE)
}

export interface PageTemplate {
  id: string
  /** Shown in the picker (Chinese). */
  label: string
  frames: FrameNode
}

const third = 1 / 3
const row = (ratio = 0.5): FrameSplit => split('x', ratio, panel(), panel())

/** Ready-made pages; the storyboard picks one per page, and a person can start from one. */
export const PAGE_TEMPLATES: PageTemplate[] = [
  { id: 'single', label: '整页一格', frames: panel() },
  { id: 'two-rows', label: '上下两格', frames: split('y', 0.5, panel(), panel()) },
  { id: 'three-rows', label: '横向三格', frames: split('y', third, panel(), split('y', 0.5, panel(), panel())) },
  { id: 'wide-then-two', label: '一宽两窄', frames: split('y', 0.45, panel(), row()) },
  { id: 'two-then-wide', label: '两窄一宽', frames: split('y', 0.55, row(), panel()) },
  { id: 'grid-four', label: '田字四格', frames: split('y', 0.5, row(), row()) },
  { id: 'classic-five', label: '经典五格', frames: split('y', 0.3, panel(), split('y', 0.5, row(0.55), row(0.45))) },
  { id: 'six-grid', label: '六格', frames: split('y', third, row(), split('y', 0.5, row(), row())) },
]

/** Panels a storyboard page holds at most: the largest template. */
export const MAX_PANELS_PER_PAGE = Math.max(...PAGE_TEMPLATES.map((template) => leafCount(template.frames)))

export function templateById(id: string): PageTemplate | undefined {
  return PAGE_TEMPLATES.find((template) => template.id === id)
}

/** The first template with exactly `count` panels, else the smallest one that has room. */
export function templateForCount(count: number): PageTemplate {
  const exact = PAGE_TEMPLATES.find((template) => leafCount(template.frames) === count)
  if (exact) return exact
  return PAGE_TEMPLATES.find((template) => leafCount(template.frames) >= count) ?? PAGE_TEMPLATES.at(-1)!
}

const GRID = 16
/** Pixels a panel is drawn with, about one megapixel whatever its shape. */
const TARGET_AREA = 1024 * 1024
const MIN_EDGE = 512
const MAX_EDGE = 2048

const snap = (value: number): number => Math.max(GRID, Math.round(value / GRID) * GRID)

/**
 * The size a panel is generated at: the shape of its frame's bounding box (with bleed, as it is printed), about
 * one megapixel, on the 16 px grid the engine needs, each edge between 512 and 2048.
 */
export function panelGenerationSize(quad: Quad): { width: number; height: number } {
  const box = boundsOf(quad)
  const ratio = Math.min(4, Math.max(0.25, box.w / box.h))
  let width = Math.sqrt(TARGET_AREA * ratio)
  let height = width / ratio
  const clampScale = Math.max(MIN_EDGE / Math.min(width, height), 1) * Math.min(MAX_EDGE / Math.max(width, height), 1)
  width *= clampScale
  height *= clampScale
  return {
    width: Math.min(MAX_EDGE, Math.max(MIN_EDGE, snap(width))),
    height: Math.min(MAX_EDGE, Math.max(MIN_EDGE, snap(height))),
  }
}
