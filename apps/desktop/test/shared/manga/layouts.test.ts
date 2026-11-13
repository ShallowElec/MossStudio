import { describe, expect, it } from 'vitest'
import {
  MAX_PANELS_PER_PAGE,
  PAGE_HEIGHT,
  PAGE_LAYOUTS,
  PAGE_MARGIN,
  PAGE_WIDTH,
  PANEL_GUTTER,
  layoutById,
  layoutForCount,
  orientedRects,
  panelGenerationSize,
  panelPixelRect,
} from '@shared/manga/layouts'

describe('page layouts', () => {
  it('cover the page exactly, without overlapping panels', () => {
    for (const layout of PAGE_LAYOUTS) {
      const area = layout.rects.reduce((sum, rect) => sum + rect.w * rect.h, 0)
      expect(area, layout.id).toBeCloseTo(1, 6)
      for (const rect of layout.rects) {
        expect(rect.x + rect.w, layout.id).toBeLessThanOrEqual(1 + 1e-9)
        expect(rect.y + rect.h, layout.id).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
    expect(new Set(PAGE_LAYOUTS.map((layout) => layout.id)).size).toBe(PAGE_LAYOUTS.length)
    expect(MAX_PANELS_PER_PAGE).toBe(6)
  })

  it('read right to left: the first panel of a row sits on the right, and left-to-right mirrors it', () => {
    const grid = layoutById('grid-four')!
    expect(grid.rects[0]!.x).toBeGreaterThan(grid.rects[1]!.x)
    const mirrored = orientedRects(grid, 'ltr')
    expect(mirrored[0]!.x).toBeLessThan(mirrored[1]!.x)
    expect(orientedRects(grid, 'rtl')).toBe(grid.rects)
  })

  it('picks a template by panel count, or the smallest one with room', () => {
    expect(layoutForCount(4).id).toBe('grid-four')
    expect(layoutForCount(1).id).toBe('single')
    expect(layoutForCount(9).rects.length).toBe(MAX_PANELS_PER_PAGE)
  })

  it('keeps the margins and puts a gutter between neighbours only', () => {
    const [top, bottom] = layoutById('two-rows')!.rects.map(panelPixelRect)
    expect(top).toMatchObject({ x: PAGE_MARGIN, y: PAGE_MARGIN, w: PAGE_WIDTH - 2 * PAGE_MARGIN })
    expect(bottom!.y - (top!.y + top!.h)).toBeCloseTo(PANEL_GUTTER)
    expect(bottom!.y + bottom!.h).toBeCloseTo(PAGE_HEIGHT - PAGE_MARGIN)
  })

  it('generates each panel at its shape on the 16 px grid, about one megapixel', () => {
    for (const layout of PAGE_LAYOUTS) {
      for (const rect of layout.rects) {
        const size = panelGenerationSize(rect)
        expect(size.width % 16).toBe(0)
        expect(size.height % 16).toBe(0)
        expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(512)
        expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2048)
        const pixel = panelPixelRect(rect)
        expect(size.width / size.height).toBeCloseTo(pixel.w / pixel.h, 0)
      }
    }
    const wide = panelGenerationSize(layoutById('three-rows')!.rects[0]!)
    expect(wide.width).toBeGreaterThan(wide.height)
  })
})
