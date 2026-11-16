import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'
import { readImageHeader } from '@main/services/imageHeaders'
import { jpegBytes, pngBytes, webpBytes } from './pictures'

const root = useTempDataRoot()
const source = useTempDir('training-source-')

beforeEach(() => {
  vi.resetModules()
})

async function setup() {
  const store = await import('@main/services/training/store')
  const dataset = await import('@main/services/training/dataset')
  const project = await store.createTrainingProject({ kind: 'person', samples: true })
  return { store, dataset, project, images: join(root(), 'training', project.id, 'images') }
}

describe('picture headers', () => {
  it('reads the size of PNG, JPEG and WebP pictures from their first bytes', () => {
    expect(readImageHeader(pngBytes(640, 480))).toEqual({ format: 'png', width: 640, height: 480 })
    expect(readImageHeader(jpegBytes(300, 200))).toEqual({ format: 'jpeg', width: 300, height: 200 })
    expect(readImageHeader(webpBytes(1024, 768))).toEqual({ format: 'webp', width: 1024, height: 768 })
    expect(readImageHeader(Buffer.from('not a picture at all, just some text'))).toBeNull()
  })
})

describe('training dataset', () => {
  it('copies pictures from folders recursively with their descriptions, and leaves the originals alone', async () => {
    const { dataset, project, images } = await setup()
    mkdirSync(join(source(), 'nested'), { recursive: true })
    writeFileSync(join(source(), 'a.png'), pngBytes(1024, 1024, 1))
    writeFileSync(join(source(), 'a.txt'), 'subj, smiling\n')
    writeFileSync(join(source(), 'nested', 'b.jpg'), jpegBytes(800, 600))
    writeFileSync(join(source(), 'nested', 'notes.md'), 'ignored')
    writeFileSync(join(source(), 'fake.png'), 'not a picture')

    const result = await dataset.addToDataset(project.id, [source()])

    expect(result.images.map((image) => image.name)).toEqual(['a.png', 'b.jpg'])
    expect(result.images[0]).toMatchObject({ width: 1024, height: 1024, caption: 'subj, smiling', problems: [] })
    expect(result.images[1]).toMatchObject({ width: 800, height: 600, caption: null, problems: [] })
    await dataset.setCaption(project.id, 'a.png', 'subj at the beach')
    expect(readFileSync(join(source(), 'a.txt'), 'utf8')).toBe('subj, smiling\n')
    expect(readFileSync(join(images, 'a.txt'), 'utf8')).toBe('subj at the beach\n')
  })

  it('gives a picture a free name when its name (or stem) is taken, and its description follows it', async () => {
    const { dataset, project } = await setup()
    writeFileSync(join(source(), 'cat.png'), pngBytes(1024, 1024, 1))
    writeFileSync(join(source(), 'cat.txt'), 'first')
    await dataset.addToDataset(project.id, [join(source(), 'cat.png')])
    mkdirSync(join(source(), 'other'))
    writeFileSync(join(source(), 'other', 'CAT.jpg'), jpegBytes(1024, 1024))
    writeFileSync(join(source(), 'other', 'CAT.txt'), 'second')
    const result = await dataset.addToDataset(project.id, [join(source(), 'other', 'CAT.jpg'), join(source(), 'cat.png')])
    expect(new Map(result.images.map((image) => [image.name, image.caption]))).toEqual(
      new Map([
        ['cat.png', 'first'],
        ['CAT-2.jpg', 'second'],
        ['cat-3.png', 'first'],
      ]),
    )
  })

  it('counts small pictures, duplicates (pointing at the first copy) and pictures without a description', async () => {
    const { dataset, project, images } = await setup()
    writeFileSync(join(images, '1.png'), pngBytes(1024, 1024, 7))
    writeFileSync(join(images, '1.txt'), 'subj')
    writeFileSync(join(images, '2.png'), pngBytes(400, 900, 8))
    writeFileSync(join(images, '10.png'), pngBytes(1024, 1024, 7))
    writeFileSync(join(images, '3.webp'), webpBytes(2048, 1536))
    writeFileSync(join(images, '3.txt'), '   ')

    const result = await dataset.scanDataset(project.id)

    expect(result.images.map((image) => image.name)).toEqual(['1.png', '2.png', '3.webp', '10.png'])
    expect(result.images[1]!.problems).toEqual(['small'])
    expect(result.images[3]).toMatchObject({ problems: ['duplicate'], duplicateOf: 1 })
    expect(result.images[0]!.duplicateOf).toBeUndefined()
    expect(result.counts).toEqual({ total: 4, small: 1, duplicate: 1, noCaption: 3 })
  })

  it('removes a picture with its description, and an empty description removes the .txt', async () => {
    const { dataset, project, images } = await setup()
    writeFileSync(join(images, 'a.png'), pngBytes(1024, 1024, 1))
    writeFileSync(join(images, 'b.png'), pngBytes(1024, 1024, 2))
    writeFileSync(join(images, 'a.txt'), 'subj')
    await dataset.setCaption(project.id, 'b.png', 'subj, running')
    expect(existsSync(join(images, 'b.txt'))).toBe(true)
    expect((await dataset.setCaption(project.id, 'b.png', '  ')).caption).toBeNull()
    expect(existsSync(join(images, 'b.txt'))).toBe(false)

    const result = await dataset.removeFromDataset(project.id, ['a.png'])
    expect(result.images.map((image) => image.name)).toEqual(['b.png'])
    expect(existsSync(join(images, 'a.txt'))).toBe(false)
  })

  it('refuses picture names that leave the training folder', async () => {
    const { dataset, project } = await setup()
    await expect(dataset.setCaption(project.id, '../project.json', 'x')).rejects.toMatchObject({ code: 'E_TRAINING_PICTURE' })
    await expect(dataset.removeFromDataset(project.id, ['..\\x.png'])).rejects.toMatchObject({ code: 'E_TRAINING_PICTURE' })
  })

  it('gives a run descriptions that name the trigger, as a word of its own', async () => {
    const { dataset } = await setup()
    expect(dataset.mentionsTrigger('mira，坐着', 'mira')).toBe(true)
    expect(dataset.mentionsTrigger('miranda stands', 'mira')).toBe(false)
    expect(dataset.runCaption(null, 'person', 'mira')).toBe('mira')
    expect(dataset.runCaption('坐在窗边', 'object', 'mug')).toBe('mug，坐在窗边')
    expect(dataset.runCaption('miranda stands', 'person', 'mira')).toBe('mira，miranda stands')
    expect(dataset.runCaption('一只猫', 'style', '')).toBe('一只猫')
    expect(dataset.runCaption(null, 'style', '')).toBe('')
  })
})
