import { layoutBalloon, shoutOutline } from '@shared/manga/balloons'
import { PAGE_HEIGHT, PAGE_WIDTH, layoutById, orientedRects, panelPixelRect } from '@shared/manga/layouts'
import { panelPicture, type MangaBalloon, type MangaPage, type MangaSeries } from '@shared/manga/model'
import { cloverUrl } from '../../lib/clover'

/**
 * Drawing a finished page: paper, each panel's picture cropped to its frame,
 * the frame line, then the balloons on top. The same drawing is the preview
 * and the exported PNG, so what is checked is what is exported. Paper and ink
 * are the page's own colours (black on white like print), not theme tokens.
 */

const PAPER = '#ffffff'
const INK = '#111111'
const EMPTY = '#e9e9e9'
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'

export type PictureCache = Map<string, HTMLImageElement | null>

export function loadPicture(path: string, cache: PictureCache): Promise<HTMLImageElement | null> {
  if (cache.has(path)) return Promise.resolve(cache.get(path) ?? null)
  return new Promise((resolve) => {
    const image = new Image()
    // clover:// answers with CORS headers, so the canvas stays exportable.
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      cache.set(path, image)
      resolve(image)
    }
    image.onerror = () => {
      cache.set(path, null)
      resolve(null)
    }
    image.src = cloverUrl(path)
  })
}

function coverImage(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight)
  const sw = w / scale
  const sh = h / scale
  ctx.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, x, y, w, h)
}

function balloonPath(ctx: CanvasRenderingContext2D, kind: MangaBalloon['kind'], cx: number, cy: number, rx: number, ry: number): void {
  ctx.beginPath()
  if (kind === 'narration') {
    ctx.rect(cx - rx, cy - ry, rx * 2, ry * 2)
  } else if (kind === 'shout') {
    const points = shoutOutline(cx, cy, rx, ry)
    ctx.moveTo(points[0]![0], points[0]![1])
    for (const [px, py] of points.slice(1)) ctx.lineTo(px, py)
    ctx.closePath()
  } else {
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  }
}

function drawBalloon(ctx: CanvasRenderingContext2D, balloon: MangaBalloon, x: number, y: number, w: number, h: number): void {
  const box = layoutBalloon(balloon, w, h, (size) => {
    ctx.font = `${size}px ${FONT}`
    return (text) => ctx.measureText(text).width
  })
  const cx = x + box.cx
  const cy = y + box.cy
  ctx.save()
  ctx.lineWidth = Math.max(2, box.fontSize / 10)
  ctx.strokeStyle = INK
  ctx.fillStyle = PAPER
  if (balloon.kind === 'thought') ctx.setLineDash([box.fontSize / 3, box.fontSize / 4])
  balloonPath(ctx, balloon.kind, cx, cy, box.rx, box.ry)
  ctx.fill()
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = INK
  ctx.font = `${balloon.kind === 'shout' ? 'bold ' : ''}${box.fontSize}px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const top = cy - ((box.lines.length - 1) * box.lineHeight) / 2
  box.lines.forEach((line, index) => ctx.fillText(line, cx, top + index * box.lineHeight))
  ctx.restore()
}

/** Draw `page` at full size; the pictures it needs must be in `cache` (missing ones show as a grey frame). */
export function drawPage(
  ctx: CanvasRenderingContext2D,
  series: Pick<MangaSeries, 'readingDirection'>,
  page: MangaPage,
  cache: PictureCache,
): void {
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT)
  const layout = layoutById(page.layoutId)
  if (!layout) return
  const rects = orientedRects(layout, series.readingDirection)
  page.panels.forEach((panel, index) => {
    const rect = rects[index]
    if (!rect) return
    const { x, y, w, h } = panelPixelRect(rect)
    const picture = panelPicture(panel)
    const image = picture ? cache.get(picture.path) : null
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()
    if (image) coverImage(ctx, image, x, y, w, h)
    else {
      ctx.fillStyle = EMPTY
      ctx.fillRect(x, y, w, h)
    }
    for (const balloon of panel.dialogue) if (balloon.text.trim()) drawBalloon(ctx, balloon, x, y, w, h)
    ctx.restore()
    ctx.lineWidth = 5
    ctx.strokeStyle = INK
    ctx.strokeRect(x, y, w, h)
  })
}

export async function loadPagePictures(page: MangaPage, cache: PictureCache): Promise<void> {
  await Promise.all(
    page.panels.flatMap((panel) => {
      const picture = panelPicture(panel)
      return picture ? [loadPicture(picture.path, cache)] : []
    }),
  )
}

/** The page as PNG bytes, for 导出. */
export async function renderPagePng(
  series: Pick<MangaSeries, 'readingDirection'>,
  page: MangaPage,
  cache: PictureCache,
): Promise<Uint8Array> {
  await loadPagePictures(page, cache)
  const canvas = document.createElement('canvas')
  canvas.width = PAGE_WIDTH
  canvas.height = PAGE_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法绘制页面')
  drawPage(ctx, series, page, cache)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('无法生成页面图片')
  return new Uint8Array(await blob.arrayBuffer())
}
