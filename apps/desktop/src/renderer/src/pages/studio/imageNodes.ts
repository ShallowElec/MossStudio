import { isModelFileName } from '@shared/modelImport'
import { BOARD_GAP, cardHeight, cardWidth, imageNodeSize } from './boardLayout'

/**
 * Pictures dropped or pasted onto the board. Pure. (The image canvas itself is
 * built by `createImageCanvas` in canvases.ts.)
 */

export const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|bmp)$/i

/** Whether a dropped or pasted file is a picture the board accepts. */
export function isImageFile(file: { type: string; name: string }): boolean {
  return /^image\/(png|jpeg|webp|bmp)$/.test(file.type) || IMAGE_FILE_PATTERN.test(file.name)
}

/**
 * What a file drag over the board may hold, from the types the browser shows
 * before the drop (names come only with the drop): pictures, and files or
 * folders with no type, which may be models. Anything typed otherwise (text,
 * a PDF, a video) is refused before it is let go.
 */
export function boardTakesDrag(types: readonly string[]): boolean {
  return types.every((type) => type === '' || type === 'application/octet-stream' || /^image\//.test(type))
}

/**
 * A drop on the board: pictures become cards, model files and folders go to
 * 导入模型, and the rest is refused out loud rather than dropped in silence.
 */
export function sortBoardDrop<T extends { type: string; name: string; folder?: boolean }>(
  files: readonly T[],
): { images: T[]; models: T[]; other: T[] } {
  const images: T[] = []
  const models: T[] = []
  const other: T[] = []
  for (const file of files) {
    if (isImageFile(file)) images.push(file)
    else if (file.folder || isModelFileName(file.name)) models.push(file)
    else other.push(file)
  }
  return { images, models, other }
}

/**
 * Board positions for pictures dropped at one point (pixel sizes as the
 * import returned them): the first card is centred on the point, the rest
 * follow to its right.
 */
export function dropPositions(
  pictures: ReadonlyArray<{ width: number; height: number }>,
  at: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const sizes = pictures.map(imageNodeSize)
  let x = at.x - (sizes[0] ? cardWidth(sizes[0]) / 2 : 0)
  return sizes.map((size) => {
    const spot = { x: Math.round(x), y: Math.round(at.y - cardHeight(size) / 2) }
    x += cardWidth(size) + BOARD_GAP
    return spot
  })
}
