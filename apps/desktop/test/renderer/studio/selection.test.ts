import { describe, expect, it } from 'vitest'
import { BOARD_GAP, cardRect } from '@renderer/pages/studio/boardLayout'
import {
  MINIMAP_MIN_BOARD,
  boundsOf,
  boxBetween,
  cardsInBox,
  minimapFit,
  minimapHelps,
  readingOrder,
  tidyPlaces,
  toggled,
} from '@renderer/pages/studio/selection'

// A 1024 px picture is a 256 px card (BOARD_UNIT 0.25).
const card = (id: string, x: number, y: number, width = 1024, height = 1024) => ({ id, x, y, width, height })

describe('studio/selection', () => {
  it('draws the box whichever way the pointer went', () => {
    expect(boxBetween({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 60 })
  })

  it('picks every card the box touches, not only those inside it', () => {
    const cards = [card('a', 0, 0), card('b', 400, 0), card('c', 0, 600)]
    expect(cardsInBox(cards, { x: 200, y: 100, w: 250, h: 50 })).toEqual(['a', 'b'])
    expect(cardsInBox(cards, { x: 300, y: 400, w: 50, h: 50 })).toEqual([])
  })

  it('toggles a card in and out of the picked ones', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggled(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('reads cards top to bottom, then left to right', () => {
    expect(readingOrder([card('c', 0, 300), card('b', 300, 0), card('a', 0, 0)]).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('lays cards out in rows of about √n from the group corner, rows as tall as their tallest card', () => {
    const cards = [
      card('a', 500, 900),
      card('b', 100, 100),
      card('c', 900, 100, 1024, 2048),
      card('d', 100, 700, 512, 512),
      card('e', 300, 300),
    ]
    const places = tidyPlaces(cards)
    const corner = boundsOf(cards)!
    const at = Object.fromEntries(places.map((place) => [place.id, place]))
    const w = cardRect(card('x', 0, 0)).w
    // Reading order b, c, e, d, a; three columns.
    expect(at['b']).toEqual({ id: 'b', x: corner.x, y: corner.y })
    expect(at['c']).toEqual({ id: 'c', x: corner.x + w + BOARD_GAP, y: corner.y })
    expect(at['e']).toEqual({ id: 'e', x: corner.x + 2 * (w + BOARD_GAP), y: corner.y })
    const secondRow = corner.y + cardRect(card('c', 0, 0, 1024, 2048)).h + BOARD_GAP
    expect(at['d']).toEqual({ id: 'd', x: corner.x, y: secondRow })
    expect(at['a']!.y).toBe(secondRow)
  })

  it('fits the cards into the minimap, centred, with a margin', () => {
    const bounds = { x: 1000, y: 0, w: 2000, h: 1000 }
    const fit = minimapFit(bounds, { width: 196, height: 128 })
    const left = bounds.x * fit.scale + fit.offset.x
    const right = (bounds.x + bounds.w) * fit.scale + fit.offset.x
    expect(left).toBeGreaterThan(0)
    expect(right).toBeLessThan(196)
    expect(left + right).toBeCloseTo(196)
    const top = bounds.y * fit.scale + fit.offset.y
    const bottom = (bounds.y + bounds.h) * fit.scale + fit.offset.y
    expect(top + bottom).toBeCloseTo(128)
  })
})

describe('studio/selection minimap', () => {
  const view = { zoom: 1, pan: { x: 0, y: 0 } }
  const board = { width: 1000, height: 700 }

  it('shows only once the cards reach past the part of the board on screen', () => {
    // One card, all of it on screen: the minimap would only cover the board.
    expect(minimapHelps([card('a', 100, 100)], view, board)).toBe(false)
    expect(minimapHelps([], view, board)).toBe(false)
    // A card past the right edge, or above the top once panned, or everything once zoomed in.
    expect(minimapHelps([card('a', 100, 100), card('b', 900, 100)], view, board)).toBe(true)
    expect(minimapHelps([card('a', 100, 100)], { zoom: 1, pan: { x: 0, y: -200 } }, board)).toBe(true)
    expect(minimapHelps([card('a', 100, 100), card('b', 600, 300)], { zoom: 2, pan: { x: 0, y: 0 } }, board)).toBe(true)
  })

  it('stays away on a narrow board, where it would cover too much of it', () => {
    const narrow = { width: MINIMAP_MIN_BOARD - 1, height: 700 }
    expect(minimapHelps([card('a', 100, 100), card('b', 2000, 100)], view, narrow)).toBe(false)
    expect(minimapHelps([card('a', 100, 100), card('b', 2000, 100)], view, { width: MINIMAP_MIN_BOARD, height: 700 })).toBe(true)
  })
})
