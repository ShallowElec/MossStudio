import type { BalloonKind, MangaBalloon } from './model'

/**
 * Lettering (对白气泡): where a panel's balloons start, and how a balloon's
 * text breaks into lines and how big the balloon is. Text is measured by a
 * function the caller passes (a canvas `measureText` when drawing), so this
 * stays pure and testable.
 */

export const BALLOON_KIND_LABEL: Record<BalloonKind, string> = {
  speech: '对白',
  thought: '心声',
  shout: '喊叫',
  narration: '旁白',
}

/**
 * Where a balloon sits: nine spots on the panel. `x` and `y` are anchors, not
 * centres: 0 puts the balloon against the left (top) edge, 1 against the right
 * (bottom), 0.5 in the middle, so a corner spot keeps a big balloon in the
 * corner instead of over the middle of the picture, where faces usually are.
 */
export const BALLOON_SPOTS = [
  { value: 'tr', label: '右上', x: 1, y: 0 },
  { value: 'tc', label: '中上', x: 0.5, y: 0 },
  { value: 'tl', label: '左上', x: 0, y: 0 },
  { value: 'mr', label: '右中', x: 1, y: 0.5 },
  { value: 'mc', label: '中间', x: 0.5, y: 0.5 },
  { value: 'ml', label: '左中', x: 0, y: 0.5 },
  { value: 'br', label: '右下', x: 1, y: 1 },
  { value: 'bc', label: '中下', x: 0.5, y: 1 },
  { value: 'bl', label: '左下', x: 0, y: 1 },
] as const

export type BalloonSpot = (typeof BALLOON_SPOTS)[number]

export function nearestSpot(x: number, y: number): BalloonSpot {
  let best: BalloonSpot = BALLOON_SPOTS[0]
  for (const spot of BALLOON_SPOTS) {
    if (Math.hypot(spot.x - x, spot.y - y) < Math.hypot(best.x - x, best.y - y)) best = spot
  }
  return best
}

/** Corners in reading order: the top corner read first, then the other top corner, then the bottom ones. */
const READING_CORNERS: Record<'rtl' | 'ltr', ReadonlyArray<{ x: number; y: number }>> = {
  rtl: [
    { x: 1, y: 0 },
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  ltr: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ],
}

/**
 * First places for `count` balloons in a panel: the corners in reading order
 * (right first for right-to-left), then the middle of the top and bottom edges.
 * The middle of the picture is left to the characters.
 */
export function defaultBalloonPlaces(count: number, direction: 'rtl' | 'ltr'): Array<{ x: number; y: number }> {
  const order = [...READING_CORNERS[direction], { x: 0.5, y: 0 }, { x: 0.5, y: 1 }]
  return Array.from({ length: Math.max(0, count) }, (_, index) => ({ ...order[index % order.length]! }))
}

export type Measure = (text: string) => number

/** Never at the start of a line (禁则): it hangs past the edge of the line before instead. */
const NO_LINE_START = /^[。，、．！？；：）」』】〉》”’…‥ー～ぁぃぅぇぉっゃゅょ.,!?;:)\]}]/u
/** The same punctuation at the end of a line, which may pass its edge. */
const TRAILING_HANG = /[。，、．！？；：）」』】〉》”’…‥ー～ぁぃぅぇぉっゃゅょ.,!?;:)\]}]+$/u
/** Never at the end of a line: it moves down with the text it opens. */
const NO_LINE_END = /[（「『【〈《“‘([{]$/u

/**
 * Break `text` into lines no wider than `maxWidth`. Chinese and Japanese break
 * between any two characters; a run of Latin letters or digits stays whole
 * unless it alone is too wide. Explicit newlines are kept.
 */
export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    const tokens = paragraph.match(/[A-Za-z0-9'’.,!?-]+\s*|\s+|./gu) ?? []
    let line = ''
    for (const token of tokens) {
      const candidate = line + token
      if (!line || measure(candidate.trimEnd()) <= maxWidth || NO_LINE_START.test(token)) {
        line = candidate
        continue
      }
      const opener = NO_LINE_END.test(line) && line.length > 1 ? line.slice(-1) : ''
      lines.push(line.slice(0, line.length - opener.length).trimEnd())
      line = opener + token.trimStart()
    }
    // A single token wider than the line is split by character.
    const pending = [line.trimEnd()]
    while (pending.length) {
      const current = pending.shift()!
      // Hanging punctuation may pass the edge.
      if (measure(current.replace(TRAILING_HANG, '')) <= maxWidth || current.length <= 1) {
        lines.push(current)
        continue
      }
      let cut = current.length - 1
      while (cut > 1 && measure(current.slice(0, cut)) > maxWidth) cut -= 1
      while (cut > 1 && NO_LINE_START.test(current.slice(cut))) cut -= 1
      lines.push(current.slice(0, cut))
      pending.unshift(current.slice(cut))
    }
  }
  return lines
}

export interface BalloonBox {
  lines: string[]
  /** Centre and half-size in panel pixels. */
  cx: number
  cy: number
  rx: number
  ry: number
  fontSize: number
  lineHeight: number
}

/**
 * A balloon's text lines and its size inside a panel of `panelW` × `panelH`
 * pixels: text up to 30% of the panel wide (tall narrow balloons cover less of
 * a figure than wide ones), placed by its anchor with a margin from the edges.
 * Ellipses need more room around the text than the narration box.
 */
export function layoutBalloon(
  balloon: Pick<MangaBalloon, 'kind' | 'text' | 'x' | 'y'>,
  panelW: number,
  panelH: number,
  measureAt: (fontSize: number) => Measure,
): BalloonBox {
  const fontSize = Math.round(Math.max(18, Math.min(36, Math.min(panelW, panelH) * 0.04)))
  const lineHeight = Math.round(fontSize * 1.3)
  const measure = measureAt(fontSize)
  const maxText = Math.max(fontSize * 4, panelW * 0.3)
  const lines = wrapText(balloon.text.trim() || '…', maxText, measure)
  const textW = Math.max(fontSize, ...lines.map((line) => measure(line)))
  const textH = lines.length * lineHeight
  const ellipse = balloon.kind !== 'narration'
  const padX = ellipse ? fontSize * 1.2 : fontSize * 0.6
  const padY = ellipse ? fontSize * 1.0 : fontSize * 0.5
  const rx = Math.min(panelW / 2, (ellipse ? (textW / 2) * Math.SQRT2 : textW / 2) + padX / 2)
  const ry = Math.min(panelH / 2, (ellipse ? (textH / 2) * Math.SQRT2 : textH / 2) + padY / 2)
  const margin = Math.round(fontSize * 0.6)
  const place = (anchor: number, size: number, radius: number): number => {
    const free = Math.max(0, size - 2 * radius - 2 * margin)
    const at = margin + radius + Math.min(1, Math.max(0, anchor)) * free
    return Math.min(size - radius, Math.max(radius, at))
  }
  const cx = place(balloon.x, panelW, rx)
  const cy = place(balloon.y, panelH, ry)
  return { lines, cx, cy, rx, ry, fontSize, lineHeight }
}

/** Points of a shout balloon's spiky outline around the ellipse (rx, ry). */
export function shoutOutline(cx: number, cy: number, rx: number, ry: number, spikes = 14): Array<[number, number]> {
  const points: Array<[number, number]> = []
  for (let index = 0; index < spikes * 2; index += 1) {
    const angle = (Math.PI * index) / spikes
    const scale = index % 2 === 0 ? 1.18 : 0.9
    points.push([cx + Math.cos(angle) * rx * scale, cy + Math.sin(angle) * ry * scale])
  }
  return points
}
