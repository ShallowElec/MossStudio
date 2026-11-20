import { ClipboardItem, app, clipboard, nativeImage } from 'electron'
import { constants, existsSync, readFileSync } from 'node:fs'
import { copyFile, lstat, realpath, stat, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type { GalleryExportProgress, GalleryExportResult, GallerySaveResult } from '@shared/types'
import { codedError } from '../lib/codedError'
import { showOpenDialogFor, showSaveDialogFor } from '../lib/dialogs'
import { isInside } from '../lib/paths'
import { galleryRoots } from './gallery'
import { GALLERY_IMAGE_EXT, sidecarPath, sidecarsToTrash } from './galleryMeta'

/**
 * Getting pictures out of MossStudio: the clipboard, 另存为…, 导出到文件夹…
 * and dragging into another app. Every path comes from the renderer, so each
 * one must be a picture the gallery lists before anything reads it.
 */

/** Longest edge of the picture that follows the pointer during a drag out. */
const DRAG_ICON_EDGE = 96

/**
 * The symlink-resolved path of a picture inside a gallery root, or a coded
 * error. The check runs on the resolved path and callers read that path, so a
 * link cannot hand out a file from elsewhere.
 */
export async function galleryPicture(file: string, roots?: readonly string[]): Promise<string> {
  let real: string
  try {
    real = await realpath(file)
  } catch {
    throw codedError('E_NOT_FOUND', '找不到这张图片，可能已被移动或删除')
  }
  const listed = (roots ?? (await realGalleryRoots())).some((root) => isInside(root, real) && real !== root)
  if (!listed || !GALLERY_IMAGE_EXT.has(extname(real).toLowerCase())) {
    throw codedError('E_NOT_GALLERY', '这张图片不在作品目录中')
  }
  if (!(await stat(real)).isFile()) throw codedError('E_NOT_GALLERY', '这张图片不在作品目录中')
  return real
}

/** The gallery roots, symlinks resolved; an export reads them once for all its pictures. */
async function realGalleryRoots(): Promise<string[]> {
  return Promise.all((await galleryRoots()).map((root) => realpath(root).catch(() => resolve(root))))
}

export async function copyPictureToClipboard(file: string): Promise<true> {
  const image = nativeImage.createFromPath(await galleryPicture(file))
  // nativeImage reads PNG and JPEG everywhere; WebP only on some systems.
  if (image.isEmpty()) throw codedError('E_IMAGE_FORMAT', '这张图片的格式不能复制，可以用「另存为…」保存后再用')
  // As PNG whatever the file is: the one picture type every app takes from the clipboard.
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
  return true
}

export async function savePictureAs(sender: Electron.WebContents, file: string): Promise<GallerySaveResult | null> {
  const real = await galleryPicture(file)
  const ext = extname(real).slice(1).toLowerCase()
  const result = await showSaveDialogFor(sender, {
    title: '另存为',
    defaultPath: join(app.getPath('pictures'), basename(real)),
    filters: [{ name: '图片', extensions: [ext] }],
  })
  if (result.canceled || !result.filePath) return null
  const typed = resolve(result.filePath)
  if (extname(typed)) {
    // The save dialog already asked before replacing a file that is there.
    if (typed !== real) await copyFile(real, typed)
    return { path: typed }
  }
  // Some Linux dialogs keep the name as typed; the dialog never asked about the name with the extension, so never replace it.
  const target = `${typed}.${ext}`
  await copyFile(real, target, constants.COPYFILE_EXCL)
  return { path: target }
}

/** `name.png`, then `name-2.png`, `name-3.png`… */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name
  const ext = extname(name)
  return `${basename(name, ext)}-${n}${ext}`
}

/** Where a picture's sidecar goes when the picture is copied to `target`. */
function sidecarTarget(sidecar: string, source: string, target: string): string {
  return sidecar === `${source}.json` ? `${target}.json` : sidecarPath(target)
}

/**
 * Copies `source` into `dir` under its own name or the first numbered one
 * that is free for the picture and every sidecar it brings, never replacing a
 * file. Returns the picture's new path.
 */
export async function copyWithoutReplacing(source: string, dir: string, sidecars: readonly string[] = []): Promise<string> {
  const name = basename(source)
  for (let n = 1; n < 10_000; n += 1) {
    const target = join(dir, numberedName(name, n))
    const companions = sidecars.map((sidecar) => [sidecar, sidecarTarget(sidecar, source, target)] as const)
    if (existsSync(target) || companions.some(([, path]) => existsSync(path))) continue
    try {
      // EXCL: a file that appeared since the check is skipped, not replaced.
      await copyFile(source, target, constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      // A half-written copy (a full disk, say) is not left behind.
      await unlink(target).catch(() => undefined)
      throw error
    }
    for (const [sidecar, path] of companions) {
      try {
        // A link in place of a sidecar could point anywhere; only a plain file is copied.
        if (!(await lstat(sidecar)).isFile()) continue
        await copyFile(sidecar, path, constants.COPYFILE_EXCL)
      } catch {
        // the picture is what was asked for; a missing sidecar only drops its parameters
      }
    }
    return target
  }
  throw codedError('E_EXPORT_NAME', `「${name}」的同名文件太多了`)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * 导出到文件夹…: asks for a folder in a dialog on the window, then copies each
 * picture there, with its sidecars when `withParams` is on. Pictures that are
 * gone or not in the gallery are counted as failed, not fatal. Null when the
 * person cancels the dialog.
 */
export async function exportPictures(
  sender: Electron.WebContents,
  files: readonly string[],
  withParams: boolean,
  onProgress: (progress: GalleryExportProgress) => void,
): Promise<GalleryExportResult | null> {
  const result = await showOpenDialogFor(sender, {
    title: '导出到文件夹',
    buttonLabel: '导出到这里',
    properties: ['openDirectory', 'createDirectory'],
  })
  const folder = result.canceled ? undefined : result.filePaths[0]
  if (!folder) return null
  const total = files.length
  let exported = 0
  let failed = 0
  const roots = await realGalleryRoots()
  onProgress({ done: 0, total })
  for (const file of files) {
    try {
      const real = await galleryPicture(file, roots)
      // The sidecars that belong to this picture: the same ones deleting it takes along.
      const sidecars = withParams ? sidecarsToTrash(real, existsSync, readJson) : []
      await copyWithoutReplacing(real, folder, sidecars)
      exported += 1
    } catch (error) {
      failed += 1
      console.warn('[picture-export]', file, error instanceof Error ? error.message : String(error))
    }
    onProgress({ done: exported + failed, total })
  }
  return { folder, exported, failed }
}

function dragIcon(file: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(file)
  // macOS refuses a drag without an icon; a plain grey square stands in for a picture nativeImage cannot read.
  if (image.isEmpty()) return nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 0x99), { width: 32, height: 32 })
  const { width, height } = image.getSize()
  return width >= height ? image.resize({ width: DRAG_ICON_EDGE }) : image.resize({ height: DRAG_ICON_EDGE })
}

/** Hands the pictures to the OS drag that the pointer is already making, so another app can take them. */
export async function startPictureDrag(sender: Electron.WebContents, files: readonly string[]): Promise<true> {
  const roots = await realGalleryRoots()
  const real = await Promise.all(files.map((file) => galleryPicture(file, roots)))
  sender.startDrag({ file: real[0]!, files: real, icon: dragIcon(real[0]!) })
  return true
}
