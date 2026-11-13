import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deleteSeries, exportFileNames, getSeries, listSeries, saveSeries, writeChapterPages } from '@main/services/manga'
import { getProject } from '@main/services/projects'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { mangaSeriesFixture } from '../../mocks/backend/manga'

const dataRoot = useTempDataRoot()

function input(): Parameters<typeof saveSeries>[0] {
  const { schemaVersion: _version, createdAt: _created, updatedAt: _updated, id: _id, projectId: _project, ...rest } = mangaSeriesFixture()
  return rest
}

const png = (): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('manga series storage', () => {
  it('creates a series with its own Studio project for pictures, and lists it', () => {
    const series = saveSeries(input())
    expect(series.id).toMatch(/^manga-/)
    expect(series.schemaVersion).toBe(1)
    const project = getProject(series.projectId)
    expect(project).toMatchObject({ name: '漫画 · 雨夜侦探', seriesId: series.id, canvases: [] })
    expect(listSeries()).toEqual([
      expect.objectContaining({ id: series.id, title: '雨夜侦探', chapterCount: 1, characterCount: 2, panels: 3, approved: 0 }),
    ])
    expect(getSeries(series.id)).toEqual(series)
  })

  it('keeps the project and creation time on save, and renames the project with the title', () => {
    const created = saveSeries(input())
    const saved = saveSeries({ ...input(), id: created.id, title: '新名字' })
    expect(saved).toMatchObject({ id: created.id, projectId: created.projectId, createdAt: created.createdAt, title: '新名字' })
    expect(getProject(created.projectId)?.name).toBe('漫画 · 新名字')
  })

  it('makes the project again when it was deleted from the Studio', () => {
    const created = saveSeries(input())
    deleteSeries(created.id)
    const fresh = saveSeries(input())
    expect(fresh.projectId).not.toBe(created.projectId)
    expect(() => saveSeries({ ...input(), id: created.id })).toThrow('这部漫画已经删除了')
  })

  it('removes the series and its pictures together', () => {
    const series = saveSeries(input())
    deleteSeries(series.id)
    expect(getSeries(series.id)).toBeNull()
    expect(getProject(series.projectId)).toBeNull()
    expect(listSeries()).toEqual([])
  })

  it('skips files that are not a valid series, and refuses ids that are not series ids', () => {
    mkdirSync(join(dataRoot(), 'manga'), { recursive: true })
    writeFileSync(join(dataRoot(), 'manga', 'manga-broken.json'), '{"schemaVersion": 1}')
    writeFileSync(join(dataRoot(), 'manga', 'notes.txt'), 'x')
    expect(listSeries()).toEqual([])
    expect(getSeries('../projects')).toBeNull()
    expect(() => deleteSeries('project-1')).toThrow('漫画无效，请重新打开')
  })
})

describe('chapter export', () => {
  it('names pages in reading order with the chapter number', () => {
    expect(exportFileNames(3, 2)).toEqual(['第3话-01.png', '第3话-02.png'])
    expect(exportFileNames(1, 120)[0]).toBe('第1话-001.png')
  })

  it('writes the pages into a folder named after the series', () => {
    const folder = join(dataRoot(), 'export')
    const target = writeChapterPages(folder, { title: 'a/b:c', chapterNumber: 2, pages: [png(), png()] })
    expect(target).toBe(join(folder, 'a_b_c'))
    expect(readdirSync(target).sort()).toEqual(['第2话-01.png', '第2话-02.png'])
    expect([...readFileSync(join(target, '第2话-01.png'))]).toEqual([...png()])
  })

  it('refuses anything that is not a PNG', () => {
    const folder = join(dataRoot(), 'export')
    expect(() => writeChapterPages(folder, { title: 't', chapterNumber: 1, pages: [new Uint8Array([1, 2, 3])] })).toThrow('页面图片无效')
    expect(existsSync(join(folder, 't'))).toBe(false)
  })
})
