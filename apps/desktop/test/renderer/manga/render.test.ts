import { describe, expect, it } from 'vitest'
import { missingPictures, type PictureCache } from '@renderer/pages/manga/render'
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
