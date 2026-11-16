import {
  MAX_FRAME_PANELS,
  MIN_PANEL_SIDE,
  PAGE_HEIGHT,
  PAGE_MARGIN,
  PAGE_WIDTH,
  PANEL_GUTTER,
  areaOf,
  boundsOf,
  framesFit,
  leafCount,
  leafPaths,
  panel,
  panelQuads,
  replaceAt,
  spanOf,
  split,
  type FrameAxis,
  type FrameNode,
} from './layouts'
import { ANGLES, SHOTS, emptyPanel, isBlankPanel, type Angle, type MangaPage, type Shot } from './model'

/**
 * 抽卡: random page layouts in a chosen style, scored by rules of thumb and
 * sorted, plus a random shot and angle for each panel. The same seed and
 * settings always give the same draw. Ported from the 漫画分镜工作台 of Penna
 * (https://github.com/storyAura/Penna, lib/core/harness/manga/manga_gacha.dart
 * and manga_styles.dart), MIT License, Copyright (c) 2026 storyAura. The
 * random numbers here are this file's own, so a seed does not give Penna's
 * pages.
 */

/** Change when the draw changes, so an old seed does not pass for the same page. */
export const GENERATOR_VERSION = 'tiers-v2'

/** xmur3: a string to a 32-bit seed. */
function hashString(text: string): () => number {
  let h = 1779033703 ^ text.length
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return (h ^= h >>> 16) >>> 0
  }
}

/**
 * One stream of random numbers (sfc32). `scope` is what it acts on (the page id) and `category` keeps the layout
 * and shot draws apart, so drawing shots never moves the layouts.
 */
export class DrawStream {
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(seed: string, scope: string, attempt: number, category: string) {
    const next = hashString(JSON.stringify([seed, GENERATOR_VERSION, scope, attempt, category]))
    this.a = next()
    this.b = next()
    this.c = next()
    this.d = next()
  }

  next32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0
    this.d = (this.d + 1) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.c = (this.c + t) | 0
    return t >>> 0
  }

  /** 0 to n − 1, without modulo bias. */
  below(n: number): number {
    if (n <= 1) return 0
    const span = 0x100000000
    const limit = span - (span % n)
    for (;;) {
      const value = this.next32()
      if (value < limit) return value % n
    }
  }

  /** An index picked by integer weights; −1 when every weight is 0. */
  weighted(weights: number[]): number {
    const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0)
    if (total === 0) return -1
    let r = this.below(total)
    for (const [index, weight] of weights.entries()) {
      if (weight <= 0) continue
      if (r < weight) return index
      r -= weight
    }
    return weights.length - 1
  }
}

/**
 * A layout style: how many rows (tiers) a page has, and 0–100 for how often and how far gutters across (`slantH`)
 * and down (`slantV`) slant, how many edge panels bleed, how often a panel is cut again, and how likely one big
 * panel is.
 */
export interface LayoutStyle {
  tiersMin: number
  tiersMax: number
  slantH: number
  slantV: number
  bleed: number
  subdivide: number
  big: number
}

export const LAYOUT_STYLES = {
  dialogue: { tiersMin: 3, tiersMax: 4, slantH: 0, slantV: 0, bleed: 0, subdivide: 20, big: 10 },
  standard: { tiersMin: 2, tiersMax: 4, slantH: 25, slantV: 25, bleed: 20, subdivide: 20, big: 20 },
  action: { tiersMin: 2, tiersMax: 3, slantH: 55, slantV: 55, bleed: 45, subdivide: 28, big: 35 },
  splash: { tiersMin: 1, tiersMax: 3, slantH: 40, slantV: 40, bleed: 75, subdivide: 10, big: 70 },
} satisfies Record<string, LayoutStyle>
export type LayoutStyleId = keyof typeof LAYOUT_STYLES
export const LAYOUT_STYLE_LABEL: Record<LayoutStyleId, string> = { dialogue: '对话', standard: '标准', action: '动作', splash: '扉页' }

/** At full level, a slanted gutter's two ends differ by at most this much (millionths). */
const SLANT_SPAN = 150_000

function drawSlant(s: DrawStream, level: number): number {
  if (level <= 0 || s.below(100) >= Math.floor((level * 3) / 2)) return 0
  const most = Math.floor((SLANT_SPAN * level) / 100)
  return (s.below(2 * most + 1) - most) / 1_000_000
}

/** A run of parts cut one after another along `axis`, each part's share by its weight. */
function chain(parts: FrameNode[], weights: number[], axis: FrameAxis, s: DrawStream, slantLevel: number): FrameNode {
  if (parts.length === 1) return parts[0]!
  const rest = weights.slice(1).reduce((sum, weight) => sum + weight, 0)
  const ratio = Math.min(0.999999, Math.max(0.000001, Math.floor((weights[0]! * 1_000_000) / (weights[0]! + rest)) / 1_000_000))
  return split(axis, ratio, parts[0]!, chain(parts.slice(1), weights.slice(1), axis, s, slantLevel), drawSlant(s, slantLevel))
}

/** One layout in `style`, row by row; with `panels`, exactly that many. Undefined when a panel is too narrow. */
export function growTiers(style: LayoutStyle, s: DrawStream, panels?: number): FrameNode | undefined {
  let tMax = style.tiersMax
  let tMin = style.tiersMin
  if (panels !== undefined) {
    tMax = Math.min(tMax, panels)
    const least = Math.floor((panels + 5) / 6)
    tMin = Math.min(tMin, tMax)
    if (tMin < least) tMin = Math.min(least, tMax)
  }
  const tiers = tMin + s.below(tMax - tMin + 1)
  const heights = Array.from({ length: tiers }, () => 100 + s.below(61))
  if (tiers > 1 && s.below(100) < style.big) {
    const b = s.below(tiers)
    heights[b] = Math.floor((heights[b]! * (200 + style.big * 2)) / 100)
  }
  const total = heights.reduce((sum, height) => sum + height, 0)
  let count = 0
  const rows: FrameNode[] = []
  for (const height of heights) {
    const tall = Math.floor((height * 100) / total) > 45
    const cols = 1 + s.weighted(tall ? [5, 3, 1] : [2, 5, 3])
    const widths = Array.from({ length: cols }, () => 100 + s.below(81))
    if (cols > 1 && s.below(100) < Math.floor(style.big / 2)) widths[s.below(cols)]! *= 2
    const columns: FrameNode[] = []
    for (let c = 0; c < cols; c += 1) {
      if (s.below(100) < style.subdivide) {
        const stack = s.below(100) < Math.floor(style.subdivide / 3) ? 3 : 2
        count += stack
        columns.push(
          chain(
            Array.from({ length: stack }, () => panel()),
            Array.from({ length: stack }, () => 100 + s.below(61)),
            'y',
            s,
            style.slantH,
          ),
        )
      } else {
        count += 1
        columns.push(panel())
      }
    }
    rows.push(chain(columns, widths, 'x', s, style.slantV))
  }
  if (panels !== undefined && count !== panels) return undefined
  const root = chain(rows, heights, 'y', s, style.slantH)
  if (!framesFit(root)) return undefined
  if (style.bleed <= 0) return root
  const quads = panelQuads(root, 'ltr')
  const right = PAGE_WIDTH - PAGE_MARGIN
  const bottom = PAGE_HEIGHT - PAGE_MARGIN
  let index = 0
  const bleed = (node: FrameNode): FrameNode => {
    if (node.kind === 'split') return { ...node, first: bleed(node.first), second: bleed(node.second) }
    const q = quads[index++]!
    const edge = q.some((p) => p.x <= PAGE_MARGIN || p.y <= PAGE_MARGIN || p.x >= right || p.y >= bottom)
    return edge && s.below(150) < style.bleed ? panel(true) : node
  }
  return bleed(root)
}

/** Ratios a random cut picks from (three to seven, four to six…), never one too close to another to tell apart. */
const RATIO_STEPS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]

/** One cut at a time from a single panel, `n − 1` cuts; undefined when no panel has room for the next one. */
function growCuts(n: number, s: DrawStream): FrameNode | undefined {
  let root: FrameNode = panel()
  for (let i = 1; i < n; i += 1) {
    const boxes = panelQuads(root, 'ltr').map(boundsOf)
    const choices: Array<{ index: number; axis: FrameAxis }> = []
    const weights: number[] = []
    for (const [index, box] of boxes.entries()) {
      for (const axis of ['x', 'y'] as const) {
        if ((axis === 'x' ? box.w : box.h) < 2 * MIN_PANEL_SIDE + PANEL_GUTTER) continue
        // Big panels are cut first; a tall one across, a wide one down. The first cut leans across: pages read in rows.
        let weight = Math.floor((Math.floor(box.w / 8) * Math.floor(box.h / 8)) / 100) + 1
        const tall = box.h >= box.w
        if ((axis === 'y' && tall) || (axis === 'x' && !tall)) weight *= 3
        if (i === 1 && axis === 'y') weight *= 2
        choices.push({ index, axis })
        weights.push(weight)
      }
    }
    const pick = s.weighted(weights)
    if (pick < 0) return undefined
    const { index, axis } = choices[pick]!
    const box = boxes[index]!
    const usable = (axis === 'x' ? box.w : box.h) - PANEL_GUTTER
    const legal = RATIO_STEPS.filter((step) => usable * step >= MIN_PANEL_SIDE && usable - usable * step >= MIN_PANEL_SIDE)
    const ratio = legal.length ? legal[s.below(legal.length)]! : 0.5
    root = replaceAt(root, leafPaths(root)[index]!, (leaf) => split(axis, ratio, leaf, panel()))
  }
  return root
}

/** Panel frames in reading order rounded to the pixel: two draws with the same key are the same page. */
function keyOf(frames: FrameNode): string {
  return panelQuads(frames, 'ltr', { bleed: true })
    .map((q) => q.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' '))
    .join('|')
}

/**
 * Score (higher is better): no long thin panels, sizes that vary, rows read one after another. Rules of thumb that
 * say nothing about the story; the main reasons a layout lost points go in `notes`.
 */
function scoreOf(frames: FrameNode): { score: number; notes: string[] } {
  const quads = panelQuads(frames, 'ltr')
  const notes: string[] = []
  let worst = 100
  for (const q of quads) {
    const span = spanOf(q)
    const long = Math.max(span.w, span.h)
    const short = Math.max(1, Math.min(span.w, span.h))
    worst = Math.max(worst, Math.floor((long * 100) / short))
  }
  const thin = worst <= 300 ? 1000 : Math.min(1000, Math.max(0, 1000 - (worst - 300) * 4))
  if (thin < 1000) notes.push('有细长的格')
  const areas = quads.map(areaOf)
  const big = Math.max(...areas)
  const small = Math.min(...areas)
  const spread = small === 0 ? 1000 : Math.floor((big * 100) / small)
  const rhythm = quads.length === 1 ? 1000 : spread < 130 ? 300 : spread < 180 ? 700 : spread <= 600 ? 1000 : 600
  if (rhythm < 1000 && spread < 180) notes.push('格的大小太平均')
  if (rhythm < 1000 && spread > 600) notes.push('大小差得太多')
  const tiers = frames.kind === 'split' && frames.axis === 'x' ? 600 : 1000
  return { score: Math.floor((thin * 3 + rhythm * 2 + 2000 + tiers) / 80), notes }
}

export interface LayoutCandidate {
  frames: FrameNode
  panels: number
  score: number
  key: string
  notes: string[]
}

export interface LayoutDraw {
  found: LayoutCandidate[]
  /** Why nothing was found, in plain words; absent when something was. */
  problem?: string
}

export interface DrawOptions {
  seed: string
  /** What the draw acts on (the page id), so two pages drawn with one seed differ. */
  scope: string
  style: LayoutStyle
  /** Exactly this many panels; absent lets the style decide. */
  panels?: number
  count?: number
  attempts?: number
}

/**
 * `count` different layouts in `style`, best first. With `panels`, only layouts with that many; when the style
 * cannot make them, the last third of the attempts cut one panel at a time instead. A short draw gives fewer; an
 * empty one says why, rather than loosening the rules.
 */
export function drawLayouts({ seed, scope, style, panels, count = 8, attempts = 300 }: DrawOptions): LayoutDraw {
  const wanted = panels === undefined ? undefined : Math.min(MAX_FRAME_PANELS, Math.max(1, panels))
  const found: LayoutCandidate[] = []
  const keys = new Set<string>()
  let noRoom = 0
  for (let attempt = 0; attempt < attempts && found.length < count; attempt += 1) {
    const s = new DrawStream(seed, scope, attempt, 'layout')
    const frames = wanted === undefined || attempt < Math.floor((attempts * 2) / 3) ? growTiers(style, s, wanted) : growCuts(wanted, s)
    if (!frames) {
      noRoom += 1
      continue
    }
    const n = leafCount(frames)
    if (n > MAX_FRAME_PANELS || (wanted !== undefined && n !== wanted)) continue
    const key = keyOf(frames)
    if (keys.has(key)) continue
    keys.add(key)
    found.push({ frames, panels: n, key, ...scoreOf(frames) })
  }
  found.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  if (found.length) return { found }
  return {
    found,
    problem: noRoom > 0 ? `一页放不下 ${wanted ?? style.tiersMin} 格（每格最短边 15 毫米）` : '没有抽到能用的分格',
  }
}

/**
 * New frames for `page`, its panels kept in reading order. Extra panels are blank; when there are fewer frames,
 * blank panels are dropped from the end first. Undefined when panels with content would have to go.
 */
export function applyFrames(page: MangaPage, frames: FrameNode, makeId: (prefix: string) => string): MangaPage | undefined {
  const want = leafCount(frames)
  const panels = [...page.panels]
  while (panels.length > want) {
    let index = panels.length - 1
    while (index >= 0 && !isBlankPanel(panels[index]!)) index -= 1
    if (index < 0) return undefined
    panels.splice(index, 1)
  }
  while (panels.length < want) panels.push(emptyPanel(makeId('panel')))
  return { ...page, frames, panels }
}

/**
 * A random shot and angle for every panel not yet drawn. A page opens wide to set the scene; wide panels lean to
 * wide shots and small ones to close-ups; the same shot twice in a row is drawn less.
 */
export function drawShots(page: MangaPage, seed: string, attempt = 0): MangaPage {
  const s = new DrawStream(seed, page.id, attempt, 'shot')
  const boxes = panelQuads(page.frames, 'ltr').map(boundsOf)
  const total = (PAGE_WIDTH - 2 * PAGE_MARGIN) * (PAGE_HEIGHT - 2 * PAGE_MARGIN)
  let last: Shot | undefined
  const panels = page.panels.map((item, index) => {
    if (item.state !== 'draft') {
      last = item.shot
      return item
    }
    const box = boxes[index]
    if (!box) return item
    const share = Math.floor((box.w * box.h * 100) / total)
    const weights = [2, 3, 4, 3, 2]
    if (index === 0) {
      weights[0]! += 4
      weights[1]! += 3
    }
    if (box.w * 10 > box.h * 16) {
      weights[0]! += 3
      weights[1]! += 2
    }
    if (share < 15) {
      weights[3]! += 3
      weights[4]! += 3
    }
    if (last) weights[SHOTS.indexOf(last)] = Math.floor(weights[SHOTS.indexOf(last)]! / 4)
    const shot = SHOTS[s.weighted(weights)]!
    const angle: Angle = ANGLES[s.weighted([6, 2, 2, 2, 1, item.cast.length >= 2 ? 3 : 0])]!
    last = shot
    return { ...item, shot, angle }
  })
  return { ...page, panels }
}
