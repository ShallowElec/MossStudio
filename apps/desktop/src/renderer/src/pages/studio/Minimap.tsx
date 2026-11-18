import { useEffect, useRef } from 'react'
import type { ProjectCanvas } from '@shared/types'
import { cn } from '../../components/ui'
import { cardRect, type View } from './boardLayout'
import { OutputImage } from './OutputImage'
import { boundsOf, minimapFit, type MinimapFit } from './selection'
import type { Point } from './wires'

const WIDTH = 208
const HEIGHT = 140
/** Where the minimap sits: its size and its distance from the board's bottom-right corner, in screen pixels. */
export const MINIMAP_BOX = { width: WIDTH, height: HEIGHT, margin: 16 }
/** The inner area, inside the frame's tonal edge. */
const INSET = 6
const INNER = { width: WIDTH - INSET * 2, height: HEIGHT - INSET * 2 }

export interface MinimapProps {
  /** The cards as drawn (a dragged card where the pointer has it). */
  cards: readonly ProjectCanvas[]
  /** The picture a card shows, if any. */
  pictureOf: (id: string) => string | null
  picked: ReadonlySet<string>
  busy: ReadonlySet<string>
  /** The view on screen right now, and a way to hear of every change (a pan does not re-render the board). */
  view: () => View
  subscribe: (listener: () => void) => () => void
  boardSize: () => { width: number; height: number }
  /** Centre the view on this board point; `done` when the pointer is let go. */
  onCenter: (point: Point, done: boolean) => void
}

function viewportStyle(view: View, board: { width: number; height: number }, fit: MinimapFit): Partial<CSSStyleDeclaration> {
  const x = (-view.pan.x / view.zoom) * fit.scale + fit.offset.x + INSET
  const y = (-view.pan.y / view.zoom) * fit.scale + fit.offset.y + INSET
  return {
    transform: `translate(${x}px, ${y}px)`,
    width: `${(board.width / view.zoom) * fit.scale}px`,
    height: `${(board.height / view.zoom) * fit.scale}px`,
  }
}

/**
 * The whole board in the corner: every card as a small picture, the part on
 * screen as a tinted area. A press or drag on it moves the view there.
 */
export function Minimap(props: MinimapProps): React.JSX.Element | null {
  const bounds = boundsOf(props.cards)
  const fit = bounds ? minimapFit(bounds, INNER) : null
  const area = useRef<HTMLDivElement>(null)
  const latest = useRef(props)
  latest.current = props
  const fitRef = useRef(fit)
  fitRef.current = fit
  const { subscribe } = props

  // The tinted area follows every view change, pans included, without a render.
  useEffect(() => {
    const draw = (): void => {
      const element = area.current
      const current = fitRef.current
      if (!element || !current) return
      Object.assign(element.style, viewportStyle(latest.current.view(), latest.current.boardSize(), current))
    }
    draw()
    const stop = subscribe(draw)
    window.addEventListener('resize', draw)
    return () => {
      stop()
      window.removeEventListener('resize', draw)
    }
  }, [subscribe, fit?.scale, fit?.offset.x, fit?.offset.y])

  if (!fit) return null

  const boardPoint = (event: React.PointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: (event.clientX - rect.left - INSET - fit.offset.x) / fit.scale,
      y: (event.clientY - rect.top - INSET - fit.offset.y) / fit.scale,
    }
  }

  return (
    <div
      data-board-ui
      data-minimap
      role="group"
      aria-label="小地图"
      className="absolute bottom-4 right-4 z-20 cursor-pointer touch-none overflow-hidden rounded-[10px] bg-raised shadow-float"
      style={{ width: WIDTH, height: HEIGHT }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        props.onCenter(boardPoint(event), false)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) props.onCenter(boardPoint(event), false)
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        event.currentTarget.releasePointerCapture(event.pointerId)
        props.onCenter(boardPoint(event), true)
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="absolute rounded-md bg-panel" style={{ inset: INSET }} />
      {props.cards.map((card) => {
        const rect = cardRect(card)
        const picture = props.picked.has(card.id) ? null : props.pictureOf(card.id)
        return (
          <div
            key={card.id}
            data-minimap-card={card.id}
            data-picked={props.picked.has(card.id) || undefined}
            className={cn('absolute overflow-hidden rounded-[2px]', props.picked.has(card.id) ? 'bg-accent' : 'bg-well-strong')}
            style={{
              left: rect.x * fit.scale + fit.offset.x + INSET,
              top: rect.y * fit.scale + fit.offset.y + INSET,
              width: Math.max(3, rect.w * fit.scale),
              height: Math.max(3, rect.h * fit.scale),
            }}
          >
            {picture ? <OutputImage path={picture} alt="" compact /> : null}
          </div>
        )
      })}
      {props.cards
        .filter((card) => props.busy.has(card.id))
        .map((card) => {
          const rect = cardRect(card)
          return (
            <span
              key={`busy-${card.id}`}
              data-minimap-busy={card.id}
              className="absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-[3px] ring-accent-soft"
              style={{
                left: (rect.x + rect.w / 2) * fit.scale + fit.offset.x + INSET,
                top: (rect.y + rect.h / 2) * fit.scale + fit.offset.y + INSET,
              }}
            />
          )
        })}
      <div ref={area} data-minimap-view className="pointer-events-none absolute left-0 top-0 rounded-[4px] bg-accent-soft" />
    </div>
  )
}
