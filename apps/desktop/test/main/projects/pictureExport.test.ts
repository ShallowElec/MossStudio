import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'

const dataRoot = useTempDataRoot()
const elsewhere = useTempDir('mossstudio-export-target-')

type Service = typeof import('@main/services/pictureExport')
let service: Service
let electron: typeof import('electron')

beforeEach(async () => {
  vi.resetModules()
  service = await import('@main/services/pictureExport')
  // Same module graph as the freshly imported service.
  electron = await import('electron')
})

afterEach(() => {
  vi.restoreAllMocks()
  ;(electron.BrowserWindow as unknown as { reset: () => void }).reset()
})

const outputs = (): string => join(dataRoot(), 'outputs')

function put(path: string, content: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

function window(): { win: Electron.BrowserWindow; sender: Electron.WebContents } {
  const win = new electron.BrowserWindow() as unknown as Electron.BrowserWindow
  return { win, sender: win.webContents }
}

const readableImage = (): Electron.NativeImage =>
  ({
    isEmpty: () => false,
    getSize: () => ({ width: 200, height: 100 }),
    resize: (size: { width?: number; height?: number }) => ({ resized: size }),
    toPNG: () => Buffer.from('png bytes'),
  }) as unknown as Electron.NativeImage

describe('galleryPicture', () => {
  it('accepts a picture the gallery lists and returns its real path', async () => {
    const file = put(join(outputs(), 'a.png'), 'png')
    expect(await service.galleryPicture(file)).toBe(file)
  })

  it('refuses a file outside the gallery, a non-picture and a missing file', async () => {
    const outside = put(join(elsewhere(), 'secret.png'), 'x')
    mkdirSync(outputs(), { recursive: true })
    await expect(service.galleryPicture(outside)).rejects.toMatchObject({ code: 'E_NOT_GALLERY' })
    await expect(service.galleryPicture(put(join(outputs(), 'notes.txt'), 'x'))).rejects.toMatchObject({ code: 'E_NOT_GALLERY' })
    await expect(service.galleryPicture(outputs())).rejects.toMatchObject({ code: 'E_NOT_GALLERY' })
    await expect(service.galleryPicture(join(outputs(), 'gone.png'))).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })

  it.runIf(process.platform !== 'win32')('refuses a link in the gallery that points outside it', async () => {
    const outside = put(join(elsewhere(), 'secret.png'), 'x')
    mkdirSync(outputs(), { recursive: true })
    const link = join(outputs(), 'link.png')
    symlinkSync(outside, link)
    await expect(service.galleryPicture(link)).rejects.toMatchObject({ code: 'E_NOT_GALLERY' })
  })
})

describe('copyPictureToClipboard', () => {
  it('puts the picture on the clipboard as an image', async () => {
    const file = put(join(outputs(), 'a.png'), 'png')
    const image = readableImage()
    const read = vi.spyOn(electron.nativeImage, 'createFromPath').mockReturnValue(image)
    const write = vi.spyOn(electron.clipboard, 'write')
    await expect(service.copyPictureToClipboard(file)).resolves.toBe(true)
    expect(read).toHaveBeenCalledWith(file)
    const [items] = write.mock.calls[0]!
    expect(items.map((item) => item.types)).toEqual([['image/png']])
    const blob = (items[0] as unknown as { items: Record<string, Blob> }).items['image/png']!
    expect(Buffer.from(await blob.arrayBuffer()).toString()).toBe('png bytes')
  })

  it('says so when the picture cannot be read as an image, and copies nothing', async () => {
    const file = put(join(outputs(), 'a.webp'), 'webp')
    const write = vi.spyOn(electron.clipboard, 'write')
    await expect(service.copyPictureToClipboard(file)).rejects.toMatchObject({ code: 'E_IMAGE_FORMAT' })
    expect(write).not.toHaveBeenCalled()
  })

  it('never reads a file outside the gallery', async () => {
    const outside = put(join(elsewhere(), 'secret.png'), 'x')
    mkdirSync(outputs(), { recursive: true })
    const read = vi.spyOn(electron.nativeImage, 'createFromPath')
    await expect(service.copyPictureToClipboard(outside)).rejects.toMatchObject({ code: 'E_NOT_GALLERY' })
    expect(read).not.toHaveBeenCalled()
  })
})

describe('savePictureAs', () => {
  it('copies the picture where the save dialog on the window says', async () => {
    const file = put(join(outputs(), 'a.png'), 'picture')
    const target = join(elsewhere(), 'mine.png')
    const save = vi.spyOn(electron.dialog, 'showSaveDialog').mockResolvedValue({ canceled: false, filePath: target })
    const { win, sender } = window()
    expect(await service.savePictureAs(sender, file)).toEqual({ path: target })
    expect(save).toHaveBeenCalledWith(win, expect.objectContaining({ title: '另存为', filters: [{ name: '图片', extensions: ['png'] }] }))
    expect(readFileSync(target, 'utf8')).toBe('picture')
  })

  it('adds the extension when the dialog kept a name without one, and never replaces that file', async () => {
    const file = put(join(outputs(), 'a.png'), 'picture')
    vi.spyOn(electron.dialog, 'showSaveDialog').mockResolvedValue({ canceled: false, filePath: join(elsewhere(), 'mine') })
    expect(await service.savePictureAs(window().sender, file)).toEqual({ path: join(elsewhere(), 'mine.png') })
    expect(readFileSync(join(elsewhere(), 'mine.png'), 'utf8')).toBe('picture')
    writeFileSync(join(elsewhere(), 'mine.png'), 'kept')
    await expect(service.savePictureAs(window().sender, file)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(join(elsewhere(), 'mine.png'), 'utf8')).toBe('kept')
  })

  it('writes nothing when the dialog is cancelled', async () => {
    const file = put(join(outputs(), 'a.png'), 'picture')
    vi.spyOn(electron.dialog, 'showSaveDialog').mockResolvedValue({ canceled: true, filePath: '' })
    expect(await service.savePictureAs(window().sender, file)).toBeNull()
    expect(readdirSync(elsewhere())).toEqual([])
  })
})

describe('numberedName', () => {
  it('keeps the name first, then numbers it before the extension', () => {
    expect(service.numberedName('moss_0001.png', 1)).toBe('moss_0001.png')
    expect(service.numberedName('moss_0001.png', 2)).toBe('moss_0001-2.png')
    expect(service.numberedName('photo.final.jpg', 3)).toBe('photo.final-3.jpg')
  })
})

describe('exportPictures', () => {
  it('copies into the picked folder without replacing anything, and reports progress', async () => {
    const a = put(join(outputs(), 'a.png'), 'new a')
    const b = put(join(outputs(), 'day', 'b.png'), 'b')
    const folder = elsewhere()
    put(join(folder, 'a.png'), 'old a')
    const open = vi.spyOn(electron.dialog, 'showOpenDialog').mockResolvedValue({ canceled: false, filePaths: [folder] })
    const progress: Array<{ done: number; total: number }> = []
    const { win, sender } = window()

    const result = await service.exportPictures(sender, [a, b], false, (step) => progress.push(step))

    expect(result).toEqual({ folder, exported: 2, failed: 0 })
    expect(open).toHaveBeenCalledWith(win, expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }))
    expect(readFileSync(join(folder, 'a.png'), 'utf8')).toBe('old a')
    expect(readFileSync(join(folder, 'a-2.png'), 'utf8')).toBe('new a')
    expect(readFileSync(join(folder, 'b.png'), 'utf8')).toBe('b')
    expect(progress).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ])
  })

  it('brings each picture’s sidecar along under the same new name when asked for the parameters', async () => {
    const a = put(join(outputs(), 'a.png'), 'a')
    put(join(outputs(), 'a.json'), JSON.stringify({ job_id: 'job-1', prompt: '灯塔' }))
    const b = put(join(outputs(), 'b.png'), 'b')
    put(`${b}.json`, JSON.stringify({ prompt: '雨夜' }))
    const folder = elsewhere()
    // Only the sidecar's name is taken: the picture moves on to a free number for both.
    put(join(folder, 'a.json'), 'someone else’s')
    vi.spyOn(electron.dialog, 'showOpenDialog').mockResolvedValue({ canceled: false, filePaths: [folder] })

    await service.exportPictures(window().sender, [a, b], true, () => undefined)

    expect(readdirSync(folder).sort()).toEqual(['a-2.json', 'a-2.png', 'a.json', 'b.png', 'b.png.json'])
    expect(readFileSync(join(folder, 'a.json'), 'utf8')).toBe('someone else’s')
    expect(JSON.parse(readFileSync(join(folder, 'a-2.json'), 'utf8'))).toMatchObject({ job_id: 'job-1' })
  })

  it.runIf(process.platform !== 'win32')('never follows a sidecar that is a link to somewhere else', async () => {
    const a = put(join(outputs(), 'a.png'), 'a')
    const secret = put(join(elsewhere(), 'secret', 'keys.json'), '{"prompt":"secret"}')
    symlinkSync(secret, `${a}.json`)
    const folder = join(elsewhere(), 'out')
    mkdirSync(folder)
    vi.spyOn(electron.dialog, 'showOpenDialog').mockResolvedValue({ canceled: false, filePaths: [folder] })
    await service.exportPictures(window().sender, [a], true, () => undefined)
    expect(readdirSync(folder)).toEqual(['a.png'])
  })

  it('leaves the sidecars out by default', async () => {
    const a = put(join(outputs(), 'a.png'), 'a')
    put(join(outputs(), 'a.json'), JSON.stringify({ job_id: 'job-1' }))
    vi.spyOn(electron.dialog, 'showOpenDialog').mockResolvedValue({ canceled: false, filePaths: [elsewhere()] })
    await service.exportPictures(window().sender, [a], false, () => undefined)
    expect(readdirSync(elsewhere())).toEqual(['a.png'])
  })

  it('counts a picture that is gone or outside the gallery as failed and copies the rest', async () => {
    const a = put(join(outputs(), 'a.png'), 'a')
    const outside = put(join(elsewhere(), 'source', 'secret.png'), 'secret')
    const folder = join(elsewhere(), 'out')
    mkdirSync(folder)
    vi.spyOn(electron.dialog, 'showOpenDialog').mockResolvedValue({ canceled: false, filePaths: [folder] })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await service.exportPictures(window().sender, [join(outputs(), 'gone.png'), outside, a], false, () => undefined)

    expect(result).toEqual({ folder, exported: 1, failed: 2 })
    expect(readdirSync(folder)).toEqual(['a.png'])
  })

  it('copies nothing when the folder dialog is cancelled', async () => {
    const a = put(join(outputs(), 'a.png'), 'a')
    vi.spyOn(electron.dialog, 'showOpenDialog').mockResolvedValue({ canceled: true, filePaths: [] })
    const progress = vi.fn()
    expect(await service.exportPictures(window().sender, [a], false, progress)).toBeNull()
    expect(progress).not.toHaveBeenCalled()
  })
})

describe('copyWithoutReplacing', () => {
  it('skips every number already taken', async () => {
    const a = put(join(outputs(), 'a.png'), 'a')
    const folder = elsewhere()
    put(join(folder, 'a.png'), '1')
    put(join(folder, 'a-2.png'), '2')
    expect(await service.copyWithoutReplacing(a, folder)).toBe(join(folder, 'a-3.png'))
    expect(existsSync(join(folder, 'a-3.png'))).toBe(true)
  })
})

describe('startPictureDrag', () => {
  it('hands the real paths to the drag the window is making, with a small picture as its icon', async () => {
    const a = put(join(outputs(), 'a.png'), 'a')
    const b = put(join(outputs(), 'b.png'), 'b')
    vi.spyOn(electron.nativeImage, 'createFromPath').mockReturnValue(readableImage())
    const { sender } = window()
    const drag = vi.spyOn(sender, 'startDrag')
    await service.startPictureDrag(sender, [a, b])
    expect(drag).toHaveBeenCalledWith({ file: a, files: [a, b], icon: { resized: { width: 96 } } })
  })

  it('still drags a picture nativeImage cannot read, with a plain icon', async () => {
    const a = put(join(outputs(), 'a.webp'), 'a')
    const { sender } = window()
    const drag = vi.spyOn(sender, 'startDrag')
    await service.startPictureDrag(sender, [a])
    const icon = drag.mock.calls[0]![0].icon as Electron.NativeImage
    expect(icon.isEmpty()).toBe(false)
  })

  it('starts no drag when one of the paths is outside the gallery', async () => {
    const a = put(join(outputs(), 'a.png'), 'a')
    const outside = put(join(elsewhere(), 'secret.png'), 'x')
    const { sender } = window()
    const drag = vi.spyOn(sender, 'startDrag')
    await expect(service.startPictureDrag(sender, [a, outside])).rejects.toMatchObject({ code: 'E_NOT_GALLERY' })
    expect(drag).not.toHaveBeenCalled()
  })
})
