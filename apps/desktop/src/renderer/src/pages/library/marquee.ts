import { overlaps, type Rect } from '../studio/boardLayout'
import { boxBetween } from '../studio/selection'
import { joinPicks } from './logic'

/** How far (pixels) a press on empty space must move before it draws a box. */
const BOX_START = 4

export interface MarqueeOptions {
  /** Picks the box adds to (Ctrl, ⌘ or Shift held); empty to start afresh. */
  base: readonly string[]
  /** The tiles the box touches, joined to `base`. */
  onPick: (paths: string[]) => void
  /** The box in the element's content coordinates, or null once it is let go. */
  onBox: (box: Rect | null) => void
  /** A press that did not move, with no modifier held: let every pick go. */
  onClear: () => void
}

/**
 * A box drawn from a press on empty space in a scrolling grid of
 * `[data-library-item]` tiles. The box is kept in content coordinates, so it
 * stays on the tiles when the list scrolls under it, and the picks are worked
 * out again from where the pointer is let go: the last move the page saw may
 * be short of it after a fast drag.
 */
export function startMarquee(
  element: HTMLElement,
  press: { pointerId: number; clientX: number; clientY: number },
  options: MarqueeOptions,
): void {
  const { pointerId } = press
  const content = (clientX: number, clientY: number): { x: number; y: number } => {
    const frame = element.getBoundingClientRect()
    return { x: clientX - frame.left + element.scrollLeft, y: clientY - frame.top + element.scrollTop }
  }
  const origin = content(press.clientX, press.clientY)
  let pointer = { clientX: press.clientX, clientY: press.clientY }
  let moved = false

  const update = (): void => {
    const box = boxBetween(origin, content(pointer.clientX, pointer.clientY))
    const touched = [...element.querySelectorAll<HTMLElement>('[data-library-item]')]
      .filter((tile) => {
        const rect = tile.getBoundingClientRect()
        const corner = content(rect.left, rect.top)
        return overlaps({ x: corner.x, y: corner.y, w: rect.width, h: rect.height }, box)
      })
      .map((tile) => tile.dataset.libraryItem!)
    options.onPick(joinPicks(options.base, touched))
    options.onBox(box)
  }
  const follow = (next: PointerEvent): boolean => {
    if (next.pointerId !== pointerId) return false
    pointer = { clientX: next.clientX, clientY: next.clientY }
    if (!moved && Math.hypot(next.clientX - press.clientX, next.clientY - press.clientY) >= BOX_START) moved = true
    return moved
  }
  const move = (next: PointerEvent): void => {
    if (follow(next)) update()
  }
  const scroll = (): void => {
    if (moved) update()
  }
  const stop = (next: PointerEvent): void => {
    if (next.pointerId !== pointerId) return
    element.removeEventListener('pointermove', move)
    element.removeEventListener('pointerup', stop)
    element.removeEventListener('pointercancel', stop)
    element.removeEventListener('scroll', scroll)
    try {
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
    } catch {
      // the pointer is already gone
    }
    if (next.type === 'pointerup') {
      if (follow(next)) update()
      else if (!options.base.length) options.onClear()
    }
    options.onBox(null)
  }
  try {
    element.setPointerCapture(pointerId)
  } catch {
    // the pointer is already gone; the listeners below still end the box
  }
  element.addEventListener('pointermove', move)
  element.addEventListener('pointerup', stop)
  element.addEventListener('pointercancel', stop)
  element.addEventListener('scroll', scroll)
}
