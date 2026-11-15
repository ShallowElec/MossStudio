import { describe, expect, it } from 'vitest'
import {
  BLEED_OVERRUN,
  MAX_PANELS_PER_PAGE,
  MIN_PANEL_SIDE,
  PAGE_HEIGHT,
  PAGE_MARGIN,
  PAGE_TEMPLATES,
  PAGE_WIDTH,
  PANEL_GUTTER,
  areaOf,
  boundsOf,
  dragGutter,
  frameHandles,
  framesFit,
  innerRect,
  isBleed,
  leafCount,
  mergeFrame,
  mergeableWith,
  panel,
  panelGenerationSize,
  panelQuads,
  setBleed,
  spanOf,
  split,
  splitFrame,
  templateById,
  templateForCount,
  touchesEdge,
  type FrameNode,
  type FrameSplit,
} from '@shared/manga/layouts'

const innerW = PAGE_WIDTH - 2 * PAGE_MARGIN
const innerH = PAGE_HEIGHT - 2 * PAGE_MARGIN

describe('page frames', () => {
  it('fill the drawable area, less one gutter per cut, in every template', () => {
    for (const template of PAGE_TEMPLATES) {
      const quads = panelQuads(template.frames, 'rtl')
      expect(quads, template.id).toHaveLength(leafCount(template.frames))
      const area = quads.reduce((sum, quad) => sum + areaOf(quad), 0)
      expect(area, template.id).toBeLessThanOrEqual(innerW * innerH)
      expect(area, template.id).toBeGreaterThan(innerW * innerH * 0.9)
      expect(framesFit(template.frames), template.id).toBe(true)
    }
    expect(new Set(PAGE_TEMPLATES.map((template) => template.id)).size).toBe(PAGE_TEMPLATES.length)
    expect(MAX_PANELS_PER_PAGE).toBe(6)
  })

  it('read right to left with the first panel of a row on the right, and mirror for left to right', () => {
    const grid = templateById('grid-four')!.frames
    const [first, second] = panelQuads(grid, 'rtl').map(boundsOf)
    expect(first!.x).toBeGreaterThan(second!.x)
    const [ltrFirst, ltrSecond] = panelQuads(grid, 'ltr').map(boundsOf)
    expect(ltrFirst!.x).toBeLessThan(ltrSecond!.x)
    expect(first!.x + first!.w).toBeCloseTo(PAGE_WIDTH - ltrFirst!.x)
  })

  it('keeps the margins and puts a gutter between neighbours only', () => {
    const [top, bottom] = panelQuads(templateById('two-rows')!.frames, 'rtl').map(boundsOf)
    expect(top).toMatchObject({ x: PAGE_MARGIN, y: PAGE_MARGIN, w: innerW })
    expect(bottom!.y - (top!.y + top!.h)).toBeCloseTo(PANEL_GUTTER)
    expect(bottom!.y + bottom!.h).toBeCloseTo(PAGE_HEIGHT - PAGE_MARGIN)
    expect(top!.h).toBeCloseTo(bottom!.h)
  })

  it('slants a cut: its far end lies further along, both parts share the gutter, and balloons stay upright inside', () => {
    const slanted = split('y', 0.5, panel(), panel(), 0.1)
    const [top, bottom] = panelQuads(slanted, 'ltr')
    // Left end at half, right end at 60%.
    expect(top![3].y).toBeCloseTo(PAGE_MARGIN + (innerH - PANEL_GUTTER) * 0.5)
    expect(top![2].y).toBeCloseTo(PAGE_MARGIN + (innerH - PANEL_GUTTER) * 0.6)
    expect(bottom![0].y - top![3].y).toBeCloseTo(PANEL_GUTTER)
    const inner = innerRect(top!)
    expect(inner.y + inner.h).toBeCloseTo(top![3].y)
    expect(inner.w).toBeCloseTo(innerW)
  })

  it('lets a bleeding panel run past the paper only on the sides that touch the edge of the drawable area', () => {
    const frames = split('y', 0.5, panel(true), panel())
    const [top, bottom] = panelQuads(frames, 'rtl', { bleed: true }).map(boundsOf)
    expect(top).toMatchObject({ x: -BLEED_OVERRUN, y: -BLEED_OVERRUN, w: PAGE_WIDTH + 2 * BLEED_OVERRUN })
    // The edge against its neighbour stays where the gutter is.
    expect(top!.y + top!.h).toBeCloseTo(PAGE_MARGIN + (innerH - PANEL_GUTTER) / 2)
    expect(bottom!.x).toBe(PAGE_MARGIN)
    // Frames for editing ignore bleed.
    expect(boundsOf(panelQuads(frames, 'rtl')[0]!).x).toBe(PAGE_MARGIN)
  })

  it('cuts a panel in two, refuses one too small to cut, and merges siblings back', () => {
    const cut = splitFrame(panel(), 0, 'x')!
    expect(leafCount(cut)).toBe(2)
    expect(mergeableWith(cut, 0)).toBe(1)
    expect(mergeFrame(cut, 1)).toEqual(panel())
    // Cut until the narrowest panel has no room for another gutter and two smallest panels.
    let frames: FrameNode = panel()
    let cuts = 0
    for (;;) {
      const next = splitFrame(frames, 0, 'x')
      if (!next) break
      frames = next
      cuts += 1
    }
    expect(cuts).toBeGreaterThan(2)
    expect(framesFit(frames)).toBe(true)
    expect(spanOf(panelQuads(frames, 'ltr')[0]!).w).toBeLessThan(2 * MIN_PANEL_SIDE + PANEL_GUTTER)
    // Panels from different cuts are not siblings.
    const rows = templateById('wide-then-two')!.frames
    expect(mergeableWith(rows, 0)).toBeUndefined()
    expect(mergeFrame(rows, 0)).toBeUndefined()
  })

  it('bleeds only a panel against the edge, and merging keeps a bleed', () => {
    const three = templateById('three-rows')!.frames
    expect(touchesEdge(three, 1)).toBe(true)
    const row = split('y', 0.5, split('x', 0.5, panel(), split('x', 0.5, panel(), panel())), panel())
    const middle = split('x', 1 / 3, panel(), split('x', 0.5, panel(), panel()))
    expect(touchesEdge(split('y', 1 / 3, middle, split('y', 0.5, middle, middle)), 4)).toBe(false)
    const bled = setBleed(row, 1, true)
    expect(isBleed(bled, 1)).toBe(true)
    expect(isBleed(mergeFrame(bled, 2)!, 1)).toBe(true)
  })

  it('drags a gutter to the pointer, kept so both sides keep their narrowest side, mirrored when reading right to left', () => {
    const frames = templateById('grid-four')!.frames
    const [across, down] = frameHandles(frames, 'rtl')
    expect(across!.axis).toBe('y')
    const moved = dragGutter(frames, '', { x: 0, y: 700 }, 'rtl')!
    expect(frameHandles(moved, 'rtl')[0]!.a.y).toBeCloseTo(700)
    const tooFar = dragGutter(frames, '', { x: 0, y: PAGE_HEIGHT }, 'rtl')!
    expect(boundsOf(panelQuads(tooFar, 'rtl')[3]!).h).toBeCloseTo(MIN_PANEL_SIDE)
    // Down the top row: on a right-to-left page, the pointer moving left makes the first (right) panel wider.
    const wider = dragGutter(frames, down!.path, { x: 500, y: 300 }, 'rtl')!
    const first = boundsOf(panelQuads(wider, 'rtl')[0]!)
    expect(first.x).toBeCloseTo(500 + PANEL_GUTTER / 2)
    expect(dragGutter(frames, '0', { x: 0, y: 0 }, 'rtl')).toBeDefined()
    expect(dragGutter(frames, '00', { x: 0, y: 0 }, 'rtl')).toBeUndefined()
  })

  it('keeps a slant while dragging', () => {
    const frames = split('y', 0.5, panel(), panel(), 0.1)
    const moved = dragGutter(frames, '', { x: 0, y: 900 }, 'ltr') as FrameSplit
    expect(moved.slant).toBe(0.1)
    const handle = frameHandles(moved, 'ltr')[0]!
    expect((handle.a.y + handle.b.y) / 2).toBeCloseTo(900)
  })

  it('picks a template by panel count, or the smallest one with room', () => {
    expect(templateForCount(4).id).toBe('grid-four')
    expect(templateForCount(1).id).toBe('single')
    expect(leafCount(templateForCount(9).frames)).toBe(MAX_PANELS_PER_PAGE)
  })

  it('generates each panel at its shape on the 16 px grid, about one megapixel', () => {
    for (const template of PAGE_TEMPLATES) {
      for (const quad of panelQuads(template.frames, 'rtl')) {
        const size = panelGenerationSize(quad)
        expect(size.width % 16).toBe(0)
        expect(size.height % 16).toBe(0)
        expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(512)
        expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2048)
        const box = boundsOf(quad)
        expect(size.width / size.height).toBeCloseTo(box.w / box.h, 0)
      }
    }
    const wide = panelGenerationSize(panelQuads(templateById('three-rows')!.frames, 'rtl')[0]!)
    expect(wide.width).toBeGreaterThan(wide.height)
  })
})
