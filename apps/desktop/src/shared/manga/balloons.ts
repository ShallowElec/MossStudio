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
 * First places for `count` balloons in a panel: along the top, starting on the
 * reading side (right for right-to-left), alternating height so neighbours do
 * not overlap. Narration sits in the top corner it is read from first.
 */
export function defaultBalloonPlaces(count: number, direction: 'rtl' | 'ltr'): Array<{ x: number; y: number }> {
  if (count <= 0) return []
  const span = 0.64
  return Array.from({ length: count }, (_, index) => {
    const step = count === 1 ? 0 : (span * index) / (count - 1)
    const fromStart = 0.18 + step
    return { x: direction === 'rtl' ? 1 - fromStart : fromStart, y: index % 2 === 0 ? 0.16 : 0.3 }
  })
}

export type Measure = (text: string) => number

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
      if (!line || measure(candidate.trimEnd()) <= maxWidth) {
        line = candidate
        continue
      }
      lines.push(line.trimEnd())
      line = token.trimStart()
    }
    // A single token wider than the line is split by character.
    const pending = [line.trimEnd()]
    while (pending.length) {
      const current = pending.shift()!
      if (measure(current) <= maxWidth || current.length <= 1) {
        lines.push(current)
        continue
      }
      let cut = current.length - 1
      while (cut > 1 && measure(current.slice(0, cut)) > maxWidth) cut -= 1
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
 * pixels: text up to 40% of the panel wide, the balloon kept inside the panel.
 * Ellipses need more room around the text than the narration box.
 */
export function layoutBalloon(
  balloon: Pick<MangaBalloon, 'kind' | 'text' | 'x' | 'y'>,
  panelW: number,
  panelH: number,
  measureAt: (fontSize: number) => Measure,
): BalloonBox {
  const fontSize = Math.round(Math.max(18, Math.min(40, Math.min(panelW, panelH) * 0.045)))
  const lineHeight = Math.round(fontSize * 1.3)
  const measure = measureAt(fontSize)
  const maxText = Math.max(fontSize * 3, panelW * 0.4)
  const lines = wrapText(balloon.text.trim() || '…', maxText, measure)
  const textW = Math.max(fontSize, ...lines.map((line) => measure(line)))
  const textH = lines.length * lineHeight
  const ellipse = balloon.kind !== 'narration'
  const padX = ellipse ? fontSize * 1.2 : fontSize * 0.6
  const padY = ellipse ? fontSize * 1.0 : fontSize * 0.5
  const rx = Math.min(panelW / 2, (ellipse ? (textW / 2) * Math.SQRT2 : textW / 2) + padX / 2)
  const ry = Math.min(panelH / 2, (ellipse ? (textH / 2) * Math.SQRT2 : textH / 2) + padY / 2)
  const cx = Math.min(panelW - rx, Math.max(rx, balloon.x * panelW))
  const cy = Math.min(panelH - ry, Math.max(ry, balloon.y * panelH))
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
