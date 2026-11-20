import { afterEach, describe, expect, it, vi } from 'vitest'
import { startMarquee } from '@renderer/pages/library/marquee'

type Box = { left: number; top: number; width: number; height: number }

const rect = ({ left, top, width, height }: Box): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

/**
 * A scrolling grid at (100, 50) in the window: tile `a` at content (0, 0), `b`
 * at (200, 0) and `c` at (0, 300), each 150 px square. Rects follow scrollTop,
 * as a browser's would.
 */
function grid(): HTMLElement {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => rect({ left: 100, top: 50, width: 800, height: 400 })
  for (const [path, x, y] of [
    ['a', 0, 0],
    ['b', 200, 0],
    ['c', 0, 300],
  ] as const) {
    const tile = document.createElement('button')
    tile.dataset.libraryItem = path
    tile.getBoundingClientRect = () => rect({ left: 100 + x, top: 50 + y - element.scrollTop, width: 150, height: 150 })
    element.append(tile)
  }
  document.body.append(element)
  return element
}

const pointer = (type: string, clientX: number, clientY: number): PointerEvent =>
  new PointerEvent(type, { pointerId: 1, clientX, clientY, bubbles: true })

function start(element: HTMLElement, at: { x: number; y: number }, base: string[] = []) {
  const picks: string[][] = []
  const boxes: unknown[] = []
  const onClear = vi.fn()
  startMarquee(
    element,
    { pointerId: 1, clientX: at.x, clientY: at.y },
    { base, onPick: (paths) => picks.push(paths), onBox: (box) => boxes.push(box), onClear },
  )
  return { picks, boxes, onClear }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the 作品 box', () => {
  it('picks from where the pointer is let go, even when no move reported that spot', () => {
    const element = grid()
    // Pressed in the gap below `a` and `b`, one small move, then let go over `b` in one jump (a fast drag).
    const { picks, boxes } = start(element, { x: 120, y: 230 })
    element.dispatchEvent(pointer('pointermove', 126, 226))
    element.dispatchEvent(pointer('pointerup', 380, 120))
    expect(picks.at(-1)).toEqual(['a', 'b'])
    expect(boxes.at(-1)).toBeNull()
  })

  it('keeps the box on the tiles when the list scrolls under it', () => {
    const element = grid()
    const { picks } = start(element, { x: 120, y: 230 })
    element.dispatchEvent(pointer('pointermove', 130, 240))
    expect(picks.at(-1)).toEqual([])
    // The list scrolls 200 px down; the pointer stays put, so the box now reaches `c`.
    element.scrollTop = 200
    element.dispatchEvent(new Event('scroll'))
    expect(picks.at(-1)).toEqual(['c'])
  })

  it('adds to the picks it started with, and a press that does not move lets them go only without them', () => {
    const element = grid()
    const added = start(element, { x: 120, y: 230 }, ['c'])
    element.dispatchEvent(pointer('pointerup', 380, 120))
    expect(added.picks.at(-1)).toEqual(['c', 'a', 'b'])

    const still = start(element, { x: 120, y: 230 })
    element.dispatchEvent(pointer('pointerup', 121, 231))
    expect(still.picks).toEqual([])
    expect(still.onClear).toHaveBeenCalledOnce()

    const kept = start(element, { x: 120, y: 230 }, ['c'])
    element.dispatchEvent(pointer('pointerup', 121, 231))
    expect(kept.onClear).not.toHaveBeenCalled()
  })
})
