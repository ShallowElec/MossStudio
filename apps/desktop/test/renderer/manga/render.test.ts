import { describe, expect, it } from 'vitest'
import { drawPage, missingPictures, type PictureCache } from '@renderer/pages/manga/render'
import { BLEED_OVERRUN, panel, split } from '@shared/manga/layouts'
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
