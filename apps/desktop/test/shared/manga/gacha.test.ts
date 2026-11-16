import { describe, expect, it } from 'vitest'
import { DrawStream, LAYOUT_STYLES, applyFrames, drawLayouts, drawShots } from '@shared/manga/gacha'
import { MAX_FRAME_PANELS, framesFit, leafCount, panel, panelQuads, templateById, type FrameNode } from '@shared/manga/layouts'
import { emptyPanel, mangaPageSchema, type MangaPage } from '@shared/manga/model'

const counter = (): ((prefix: string) => string) => {
  let next = 0
  return (prefix) => `${prefix}-new-${(next += 1)}`
}

function slants(node: FrameNode): number[] {
  return node.kind === 'panel' ? [] : [node.slant ?? 0, ...slants(node.first), ...slants(node.second)]
}
function bleeds(node: FrameNode): number {
  return node.kind === 'panel' ? Number(Boolean(node.bleed)) : bleeds(node.first) + bleeds(node.second)
}

describe('layout draw', () => {
  it('gives the same numbers for the same seed, scope, attempt and category, and different ones otherwise', () => {
    const take = (stream: DrawStream): number[] => Array.from({ length: 5 }, () => stream.next32())
    expect(take(new DrawStream('a', 'page-1', 0, 'layout'))).toEqual(take(new DrawStream('a', 'page-1', 0, 'layout')))
    expect(take(new DrawStream('a', 'page-1', 0, 'layout'))).not.toEqual(take(new DrawStream('a', 'page-1', 0, 'shot')))
    expect(take(new DrawStream('a', 'page-1', 0, 'layout'))).not.toEqual(take(new DrawStream('a', 'page-2', 0, 'layout')))
    const stream = new DrawStream('b', 'p', 0, 'x')
    for (let i = 0; i < 200; i += 1) expect(stream.below(7)).toBeLessThan(7)
    expect(stream.weighted([0, 0, 5])).toBe(2)
    expect(stream.weighted([0, 0])).toBe(-1)
  })

  it('draws different layouts that fit, best first, the same way every time', () => {
    const draw = drawLayouts({ seed: 'seed', scope: 'page-1', style: LAYOUT_STYLES.standard })
    expect(draw.problem).toBeUndefined()
    expect(draw.found).toHaveLength(8)
    expect(new Set(draw.found.map((item) => item.key)).size).toBe(8)
    for (const item of draw.found) {
      expect(framesFit(item.frames)).toBe(true)
      expect(item.panels).toBe(leafCount(item.frames))
      expect(item.panels).toBeLessThanOrEqual(MAX_FRAME_PANELS)
    }
    const scores = draw.found.map((item) => item.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
    expect(drawLayouts({ seed: 'seed', scope: 'page-1', style: LAYOUT_STYLES.standard })).toEqual(draw)
    expect(drawLayouts({ seed: 'other', scope: 'page-1', style: LAYOUT_STYLES.standard }).found[0]!.key).not.toBe(draw.found[0]!.key)
  })

  it('draws exactly the asked number of panels, and says why when a page cannot hold them', () => {
    for (const panels of [1, 3, 5, 7, 12]) {
      const draw = drawLayouts({ seed: 's', scope: 'p', style: LAYOUT_STYLES.dialogue, panels, count: 4 })
      expect(draw.found.length, `${panels}`).toBeGreaterThan(0)
      for (const item of draw.found) expect(item.panels).toBe(panels)
    }
  })

  it('keeps the dialogue style straight and lets the action and splash styles slant and bleed', () => {
    const many = (style: keyof typeof LAYOUT_STYLES): FrameNode[] =>
      drawLayouts({ seed: 'style', scope: 'p', style: LAYOUT_STYLES[style], count: 24 }).found.map((item) => item.frames)
    const dialogue = many('dialogue')
    expect(dialogue.flatMap(slants).every((slant) => slant === 0)).toBe(true)
    expect(dialogue.map(bleeds).every((count) => count === 0)).toBe(true)
    expect(
      many('action')
        .flatMap(slants)
        .some((slant) => slant !== 0),
    ).toBe(true)
    expect(many('splash').some((frames) => bleeds(frames) > 0)).toBe(true)
  })

  it('applies a drawn layout keeping panels in reading order and refusing to drop one with content', () => {
    const page: MangaPage = {
      id: 'page-1',
      frames: templateById('two-rows')!.frames,
      panels: [
        { ...emptyPanel('a'), scene: '第一格' },
        { ...emptyPanel('b'), scene: '第二格' },
      ],
    }
    const four = applyFrames(page, templateById('grid-four')!.frames, counter())!
    expect(four.panels.map((item) => item.id)).toEqual(['a', 'b', 'panel-new-1', 'panel-new-2'])
    expect(mangaPageSchema.safeParse(four).success).toBe(true)
    expect(applyFrames(four, templateById('two-rows')!.frames, counter())!.panels.map((item) => item.id)).toEqual(['a', 'b'])
    expect(applyFrames(page, panel(), counter())).toBeUndefined()
  })

  it('draws shots only for panels not yet drawn, opening wide and not repeating a shot much', () => {
    const page: MangaPage = {
      id: 'page-1',
      frames: templateById('six-grid')!.frames,
      panels: Array.from({ length: 6 }, (_, index) => emptyPanel(`p${index}`)),
    }
    page.panels[2] = { ...page.panels[2]!, state: 'approved', shot: 'extreme' }
    const opening: Record<string, number> = {}
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const shot = drawShots(page, 'seed', attempt)
      expect(shot.panels[2]).toBe(page.panels[2])
      expect(shot.panels.every((item) => item.angle !== undefined || item.state !== 'draft')).toBe(true)
      expect(mangaPageSchema.safeParse(shot).success).toBe(true)
      opening[shot.panels[0]!.shot] = (opening[shot.panels[0]!.shot] ?? 0) + 1
    }
    expect((opening.wide ?? 0) + (opening.full ?? 0)).toBeGreaterThan((opening.close ?? 0) + (opening.extreme ?? 0))
    expect(drawShots(page, 'seed', 3)).toEqual(drawShots(page, 'seed', 3))
    expect(panelQuads(page.frames, 'rtl')).toHaveLength(6)
  })
})
