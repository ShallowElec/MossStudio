import { BOARD_GAP, cardRect, overlaps, type Rect } from './boardLayout'
import type { ProjectCanvas } from '@shared/types'

/**
 * Several cards picked at once (a box drawn on the empty board, Shift or Ctrl
 * clicks, Ctrl+A), what 排整齐 does with them, and how the minimap scales
 * the board. Pure, no React.
 */

type Placed = Pick<ProjectCanvas, 'id' | 'x' | 'y' | 'width' | 'height'>

/** The box between two board points, whichever way it was drawn. */
export function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

/** Cards the box touches: any overlap picks a card, it need not be inside. */
export function cardsInBox(cards: readonly Placed[], box: Rect): string[] {
  return cards.filter((card) => overlaps(cardRect(card), box)).map((card) => card.id)
}

/** Adds the card, or takes it out when it is already picked. */
export function toggled(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
}

/** Reading order: top to bottom, then left to right. */
export function readingOrder<T extends Placed>(cards: readonly T[]): T[] {
  return [...cards].sort((a, b) => a.y - b.y || a.x - b.x)
}

/** The rectangle around some cards. */
export function boundsOf(cards: readonly Placed[]): Rect | null {
  if (!cards.length) return null
  const rects = cards.map(cardRect)
  const x = Math.min(...rects.map((rect) => rect.x))
  const y = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.w))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h))
  return { x, y, w: right - x, h: bottom - y }
}

/**
 * 排整齐: the cards in reading order, in rows of about √n, starting where
 * the group's top-left corner was. Each row is as tall as its tallest card;
 * cards keep their size.
 */
export function tidyPlaces(cards: readonly Placed[]): { id: string; x: number; y: number }[] {
  const bounds = boundsOf(cards)
  if (!bounds) return []
  const columns = Math.ceil(Math.sqrt(cards.length))
  const places: { id: string; x: number; y: number }[] = []
  let y = bounds.y
  const ordered = readingOrder(cards)
  for (let start = 0; start < ordered.length; start += columns) {
    const row = ordered.slice(start, start + columns)
    let x = bounds.x
    for (const card of row) {
      places.push({ id: card.id, x: Math.round(x), y: Math.round(y) })
      x += cardRect(card).w + BOARD_GAP
    }
    y += Math.max(...row.map((card) => cardRect(card).h)) + BOARD_GAP
  }
  return places
}

/** How a board rectangle maps onto the minimap: board point × scale + offset. */
export interface MinimapFit {
  scale: number
  offset: { x: number; y: number }
}

/** Fits the cards' rectangle, with a margin, centred into the minimap's inner size. */
export function minimapFit(bounds: Rect, size: { width: number; height: number }): MinimapFit {
  const margin = Math.max(bounds.w, bounds.h) * 0.08 + BOARD_GAP
  const w = bounds.w + margin * 2
  const h = bounds.h + margin * 2
  const scale = Math.min(size.width / w, size.height / h)
  return {
    scale,
    offset: {
      x: (size.width - bounds.w * scale) / 2 - bounds.x * scale,
      y: (size.height - bounds.h * scale) / 2 - bounds.y * scale,
    },
  }
}
