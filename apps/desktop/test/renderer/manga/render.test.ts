import { describe, expect, it } from 'vitest'
import { drawPage, missingPictures, placedBalloons, type PictureCache } from '@renderer/pages/manga/render'
import { BLEED_OVERRUN, PAGE_HEIGHT, PAGE_MARGIN, PAGE_WIDTH, panel, split } from '@shared/manga/layouts'
import { mangaSeriesFixture } from '../../mocks/backend/manga'

describe('missingPictures', () => {
  it('names the panels whose chosen picture could not be read, so export refuses the page', () => {
    const page = mangaSeriesFixture().chapters[0]!.pages[0]!
    const take = (path: string) => ({ path, width: 1, height: 1, seed: 1, jobId: 'j' })
    page.panels[0]!.takes = [take('/out/a.png')]
    page.panels[1]!.takes = [take('/out/b.png')]
    page.panels[1]!.chosen = 0
    // panel 3 has no picture yet: not "missing".
    const cache: PictureCache = new Map([
      ['/out/a.png', {} as HTMLImageElement],
      ['/out/b.png', null],
    ])
    expect(missingPictures(page, cache)).toEqual([2])
    cache.set('/out/b.png', {} as HTMLImageElement)
    expect(missingPictures(page, cache)).toEqual([])
  })
})

describe('drawPage', () => {
  it('clips each picture to its slanted frame and runs a bleeding panel past the paper', () => {
    const page = mangaSeriesFixture().chapters[0]!.pages[0]!
    page.frames = split('y', 0.4, panel(true), split('x', 0.5, panel(), panel()), 0.1)
    for (const item of page.panels) item.dialogue = []
    const calls: Array<[string, number, number]> = []
    const record = (name: string) => (x: number, y: number) => calls.push([name, x, y])
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get: (_, key: string) => (key === 'moveTo' || key === 'lineTo' ? record(key) : () => undefined),
      set: () => true,
    })
    drawPage(ctx, { readingDirection: 'rtl', style: {} }, page, new Map())
    const paths = calls.filter(([name]) => name === 'moveTo').length
    // Clip and stroke for each of the three panels.
    expect(paths).toBe(6)
    const xs = calls.map(([, x]) => x)
    const ys = calls.map(([, , y]) => y)
    expect(Math.min(...xs)).toBe(-BLEED_OVERRUN)
    expect(Math.min(...ys)).toBe(-BLEED_OVERRUN)
    // The slanted gutter: the first panel's two bottom corners are at different heights.
    const first = calls.slice(0, 4).map(([, , y]) => y)
    expect(new Set(first.slice(2)).size).toBe(2)
  })
})

describe('drawPage lettering', () => {
  it('keeps a bleeding panel’s balloons on the paper', () => {
    const page = mangaSeriesFixture().chapters[0]!.pages[0]!
    page.frames = split('y', 0.4, panel(true), split('x', 0.5, panel(), panel(true)))
    page.panels[0]!.dialogue = [{ id: 'a', kind: 'speech', text: '我来看看。', x: 1, y: 0 }]
    page.panels[1]!.dialogue = []
    page.panels[2]!.dialogue = [{ id: 'b', kind: 'speech', text: '灯塔有人！', x: 0, y: 1 }]
    const ellipses: number[][] = []
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get: (_, key: string) =>
        key === 'measureText'
          ? (text: string) => ({ width: text.length * 40 })
          : key === 'ellipse'
            ? (...args: number[]) => ellipses.push(args)
            : () => undefined,
      set: () => true,
    })
    drawPage(ctx, { readingDirection: 'rtl', style: {} }, page, new Map())
    expect(ellipses).toHaveLength(2)
    for (const [cx, cy, rx, ry] of ellipses) {
      expect(cx! - rx!).toBeGreaterThanOrEqual(PAGE_MARGIN)
      expect(cy! - ry!).toBeGreaterThanOrEqual(PAGE_MARGIN)
      expect(cx! + rx!).toBeLessThanOrEqual(PAGE_WIDTH - PAGE_MARGIN)
      expect(cy! + ry!).toBeLessThanOrEqual(PAGE_HEIGHT - PAGE_MARGIN)
    }
  })

  it('places the balloons the editor drags exactly where the page draws them, and skips empty lines', () => {
    const page = mangaSeriesFixture().chapters[0]!.pages[0]!
    page.frames = split('y', 0.4, panel(true), split('x', 0.5, panel(), panel()), 0.1)
    page.panels[0]!.dialogue = [
      { id: 'a', kind: 'speech', text: '我来看看。', x: 0.3, y: 0.7 },
      { id: 'empty', kind: 'speech', text: '  ', x: 0, y: 0 },
    ]
    page.panels[1]!.dialogue = []
    page.panels[2]!.dialogue = [{ id: 'b', kind: 'shout', text: '灯塔有人！', x: 0, y: 1 }]
    const ellipses: number[][] = []
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get: (_, key: string) =>
        key === 'measureText'
          ? (text: string) => ({ width: text.length * 40 })
          : key === 'ellipse'
            ? (...args: number[]) => ellipses.push(args)
            : () => undefined,
      set: () => true,
    })
    drawPage(ctx, { readingDirection: 'rtl', style: {} }, page, new Map())
    const placed = placedBalloons(page, 'rtl', () => (text) => text.length * 40)
    expect(placed.map((item) => [item.panel, item.line.id])).toEqual([
      [0, 'a'],
      [2, 'b'],
    ])
    // The speech balloon is the first ellipse drawn; a shout is drawn as a path.
    const [cx, cy, rx, ry] = ellipses[0]!
    const { inner, box } = placed[0]!
    expect(inner.x + box.cx).toBeCloseTo(cx!)
    expect(inner.y + box.cy).toBeCloseTo(cy!)
    expect(box.rx).toBeCloseTo(rx!)
    expect(box.ry).toBeCloseTo(ry!)
  })
})
