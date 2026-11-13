/**
 * Page templates (分格). A page is a portrait sheet; each template divides it
 * into panel rectangles in reading order for right-to-left reading. Rectangles
 * are 0–1 of the drawable area inside the margins; the gutter between panels
 * is applied when a page is drawn, so templates stay simple fractions.
 */

export interface PanelRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PageLayout {
  id: string
  /** Shown in the picker (Chinese). */
  label: string
  /** Rectangles in right-to-left reading order. */
  rects: PanelRect[]
}

/** A manga page is 182 × 257 mm (B5); pages are drawn at this pixel size. */
export const PAGE_WIDTH = 1456
export const PAGE_HEIGHT = 2056
export const PAGE_MARGIN = 72
export const PANEL_GUTTER = 24

const third = 1 / 3

export const PAGE_LAYOUTS: PageLayout[] = [
  { id: 'single', label: '整页一格', rects: [{ x: 0, y: 0, w: 1, h: 1 }] },
  {
    id: 'two-rows',
    label: '上下两格',
    rects: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 },
    ],
  },
  {
    id: 'three-rows',
    label: '横向三格',
    rects: [
      { x: 0, y: 0, w: 1, h: third },
      { x: 0, y: third, w: 1, h: third },
      { x: 0, y: 2 * third, w: 1, h: third },
    ],
  },
  {
    id: 'wide-then-two',
    label: '一宽两窄',
    rects: [
      { x: 0, y: 0, w: 1, h: 0.45 },
      { x: 0.5, y: 0.45, w: 0.5, h: 0.55 },
      { x: 0, y: 0.45, w: 0.5, h: 0.55 },
    ],
  },
  {
    id: 'two-then-wide',
    label: '两窄一宽',
    rects: [
      { x: 0.5, y: 0, w: 0.5, h: 0.55 },
      { x: 0, y: 0, w: 0.5, h: 0.55 },
      { x: 0, y: 0.55, w: 1, h: 0.45 },
    ],
  },
  {
    id: 'grid-four',
    label: '田字四格',
    rects: [
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  {
    id: 'classic-five',
    label: '经典五格',
    rects: [
      { x: 0, y: 0, w: 1, h: 0.3 },
      { x: 0.45, y: 0.3, w: 0.55, h: 0.35 },
      { x: 0, y: 0.3, w: 0.45, h: 0.35 },
      { x: 0.55, y: 0.65, w: 0.45, h: 0.35 },
      { x: 0, y: 0.65, w: 0.55, h: 0.35 },
    ],
  },
  {
    id: 'six-grid',
    label: '六格',
    rects: [
      { x: 0.5, y: 0, w: 0.5, h: third },
      { x: 0, y: 0, w: 0.5, h: third },
      { x: 0.5, y: third, w: 0.5, h: third },
      { x: 0, y: third, w: 0.5, h: third },
      { x: 0.5, y: 2 * third, w: 0.5, h: third },
      { x: 0, y: 2 * third, w: 0.5, h: third },
    ],
  },
]

export const MAX_PANELS_PER_PAGE = Math.max(...PAGE_LAYOUTS.map((layout) => layout.rects.length))

export function layoutById(id: string): PageLayout | undefined {
  return PAGE_LAYOUTS.find((layout) => layout.id === id)
}

/** The first template with exactly `count` panels, else the smallest one that has room. */
export function layoutForCount(count: number): PageLayout {
  const exact = PAGE_LAYOUTS.find((layout) => layout.rects.length === count)
  if (exact) return exact
  return PAGE_LAYOUTS.find((layout) => layout.rects.length >= count) ?? PAGE_LAYOUTS.at(-1)!
}

/** Templates that hold `count` panels, for the picker. */
export function layoutsFor(count: number): PageLayout[] {
  return PAGE_LAYOUTS.filter((layout) => layout.rects.length === count)
}

/**
 * Left-to-right reading mirrors every template, so the first panel sits on
 * the left; panel order is unchanged.
 */
export function orientedRects(layout: PageLayout, direction: 'rtl' | 'ltr'): PanelRect[] {
  if (direction === 'rtl') return layout.rects
  return layout.rects.map((rect) => ({ ...rect, x: 1 - rect.x - rect.w }))
}

/** A panel's rectangle in page pixels, with half a gutter taken from every inner edge. */
export function panelPixelRect(rect: PanelRect): PanelRect {
  const innerW = PAGE_WIDTH - 2 * PAGE_MARGIN
  const innerH = PAGE_HEIGHT - 2 * PAGE_MARGIN
  const half = PANEL_GUTTER / 2
  const left = rect.x > 0.0001 ? half : 0
  const right = rect.x + rect.w < 0.9999 ? half : 0
  const top = rect.y > 0.0001 ? half : 0
  const bottom = rect.y + rect.h < 0.9999 ? half : 0
  return {
    x: PAGE_MARGIN + rect.x * innerW + left,
    y: PAGE_MARGIN + rect.y * innerH + top,
    w: rect.w * innerW - left - right,
    h: rect.h * innerH - top - bottom,
  }
}

const GRID = 16
/** Pixels a panel is drawn with, about one megapixel whatever its shape. */
const TARGET_AREA = 1024 * 1024
const MIN_EDGE = 512
const MAX_EDGE = 2048

const snap = (value: number): number => Math.max(GRID, Math.round(value / GRID) * GRID)

/**
 * The size a panel is generated at: its shape on the page, about one megapixel,
 * on the 16 px grid the engine needs, each edge between 512 and 2048.
 */
export function panelGenerationSize(rect: PanelRect): { width: number; height: number } {
  const pixel = panelPixelRect(rect)
  const ratio = Math.min(4, Math.max(0.25, pixel.w / pixel.h))
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
