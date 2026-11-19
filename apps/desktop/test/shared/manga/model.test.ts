import { describe, expect, it } from 'vitest'
import { seriesSummary, type MangaChapter, type MangaPanel, type MangaSeries } from '@shared/manga/model'
import { mangaSeriesFixture } from '../../mocks/backend/manga'

const take = (path: string) => ({ path, width: 1024, height: 768, seed: 1, jobId: 'job-1' })

function approved(panel: MangaPanel, paths: string[], chosen: number): MangaPanel {
  return { ...panel, state: 'approved', takes: paths.map(take), chosen }
}

/** A copy of `chapter` whose panel `index` on its first page is approved with `paths`. */
function withApproved(chapter: MangaChapter, index: number, paths: string[], chosen: number): MangaChapter {
  const [page] = chapter.pages
  const panels = page!.panels.map((panel, at) => (at === index ? approved(panel, paths, chosen) : panel))
  return { ...chapter, pages: [{ ...page!, panels }] }
}

describe('series summary', () => {
  it('covers a series with its first approved picture in reading order, else a character picture, else nothing', () => {
    const series = mangaSeriesFixture()
    expect(seriesSummary(series).cover).toBe('/fixture/projects/project-manga/assets/aki.png')

    const first = series.chapters[0]!
    const second: MangaChapter = { ...withApproved(first, 0, ['/out/chapter-2.png'], 0), id: 'chapter-2', number: 2 }
    // Chapter 2 is stored first, but chapter 1 comes first when read, and its chosen take is the cover.
    const drawn: MangaSeries = { ...series, chapters: [second, withApproved(first, 1, ['/out/old.png', '/out/chosen.png'], 1)] }
    expect(seriesSummary(drawn).cover).toBe('/out/chosen.png')

    const bare: MangaSeries = { ...series, characters: series.characters.map((character) => ({ ...character, references: [] })) }
    expect(seriesSummary(bare).cover).toBeNull()
  })
})
