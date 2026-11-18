import { useRef, useState } from 'react'
import type { ProjectCanvas } from '@shared/types'

/**
 * Dragging a card by its title row or its picture. `onMove` reports each step in
 * board pixels, for the board to draw the card (and its wires) there; `onDrop`
 * reports where it was let go, once, so the project changes once per drag
 * rather than on every pointer move. A drag of a few pixels or more swallows
 * the click that ends it.
 */
export function useCardDrag(options: {
  zoom: { readonly current: number }
  onMove: { readonly current: (id: string, x: number, y: number) => void }
  onDrop: { readonly current: (id: string, x: number, y: number) => void }
}): {
  draggingId: string | null
  /** True while a click is the tail of a drag and must not change the selection. */
  isDragTail: () => boolean
  start: (canvas: ProjectCanvas, event: React.PointerEvent<HTMLElement>) => void
} {
  const drag = useRef<{
    id: string
    pointerId: number
    x: number
    y: number
    origin: { x: number; y: number }
    moved: boolean
    at: { x: number; y: number }
  } | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const suppressClick = useRef(0)

  const start = (canvas: ProjectCanvas, event: React.PointerEvent<HTMLElement>): void => {
    event.stopPropagation()
    drag.current = {
      id: canvas.id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: { x: canvas.x, y: canvas.y },
      moved: false,
      at: { x: canvas.x, y: canvas.y },
    }
    // The pointer is captured only once the card moves, so a plain click or
    // double-click on the picture still reaches what is under it.
    const element = event.currentTarget
    const move = (next: PointerEvent): void => {
      const current = drag.current
      if (!current || current.pointerId !== next.pointerId) return
      if (next.buttons === 0) {
        stop(next)
        return
      }
      const dx = (next.clientX - current.x) / options.zoom.current
      const dy = (next.clientY - current.y) / options.zoom.current
      if (!current.moved && Math.abs(dx) + Math.abs(dy) < 3) return
      if (!current.moved) {
        setDraggingId(current.id)
        try {
          element.setPointerCapture(next.pointerId)
        } catch {
          // The pointer is already gone.
        }
      }
      current.moved = true
      current.at = { x: Math.round(current.origin.x + dx), y: Math.round(current.origin.y + dy) }
      options.onMove.current(current.id, current.at.x, current.at.y)
    }
    const stop = (next: PointerEvent): void => {
      const current = drag.current
      if (!current || current.pointerId !== next.pointerId) return
      drag.current = null
      setDraggingId(null)
      if (current.moved) {
        suppressClick.current = performance.now() + 300
        options.onDrop.current(current.id, current.at.x, current.at.y)
      }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', leave)
      element.removeEventListener('lostpointercapture', stop)
      if (element.hasPointerCapture(next.pointerId)) element.releasePointerCapture(next.pointerId)
    }
    // Leaving the window mid-drag ends it where the card is, so the place is written before anything else can happen.
    const leave = (): void => {
      if (drag.current) stop({ pointerId: drag.current.pointerId } as PointerEvent)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', leave)
    element.addEventListener('lostpointercapture', stop)
  }

  return { draggingId, isDragTail: () => performance.now() <= suppressClick.current, start }
}
