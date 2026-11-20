import type { CanvasImageLink, ProjectCanvas, ProjectLayer } from '@shared/types'
import { normalizeCanvasAdapters } from '@shared/adapters'
import { nextFreeSpot } from './boardLayout'
import { createLayoutCanvas, resizeCanvas, settingsFrom, type CanvasSettings } from './canvases'
import { MAX_DIMENSION, MIN_DIMENSION, DIMENSION_STEP, nextNodeTitle } from './defaults'
import { linkSourceCanvas, setLink } from './links'
import { canvasDescription, withDescription } from './prompt'
import type { Blocker } from './readiness'
import { cleanSampling } from './sampling'
import { boardCanvases, givesPicture, pictureLink, pinRun, runsOf, spotBeside } from './runs'

/**
 * The 风格 and 放大 nodes. A 风格 (`kind: 'style'`) holds a description and
 * LoRA; every 画面 wired to it generates with them, so a series stays
 * consistent and is changed in one place. A 放大 is a 画面 with `upscale`:
 * it redraws its start picture (原图) larger, at a low strength. The engine
 * has no separate upscaler; this is the same redraw 高清修复 does. Pure, no React.
 */

/** A 风格 card's size on the board (canvas pixels: a 256 × 128 card). */
export const STYLE_CARD = { width: 1024, height: 512 } as const

export const UPSCALE_SCALES = [1.5, 2] as const

/** How much a 放大 redraws: the start picture's strength (0 keeps it, 1 replaces it). */
export const UPSCALE_DETAIL = [
  { id: 'keep', label: '贴近原图', strength: 0.25 },
  { id: 'balanced', label: '适中', strength: 0.4 },
  { id: 'more', label: '更多细节', strength: 0.55 },
] as const
export const UPSCALE_DETAIL_DEFAULT = 0.4

/** What a 放大 asks for when neither it nor its 原图 has a description. */
export const UPSCALE_FALLBACK_PROMPT = '高清，细节清晰，画质细腻'

/** The 风格 nodes a canvas is wired to, in order (missing ones skipped). */
export function stylesOf(canvas: Pick<ProjectCanvas, 'inputs'>, canvases: readonly ProjectCanvas[]): ProjectCanvas[] {
  return (canvas.inputs?.styles?.links ?? []).flatMap((link) => {
    const style = canvases.find((item) => item.id === link.canvasId)
    return style?.kind === 'style' ? [style] : []
  })
}

/** The canvases wired to a 风格. */
export function styleUsers(styleId: string, canvases: readonly ProjectCanvas[]): ProjectCanvas[] {
  return canvases.filter((canvas) => canvas.kind === 'layout' && canvas.inputs?.styles?.links.some((link) => link.canvasId === styleId))
}

/**
 * The pixel size of the picture a link points at, when known. A picture
 * card's own width/height are its size on the board, not the picture's, so
 * only its recorded pixel size counts.
 */
export function pictureSize(canvases: readonly ProjectCanvas[], link: CanvasImageLink): { width: number; height: number } | null {
  const source = linkSourceCanvas(link, canvases)
  if (!source) return null
  const size = source.kind === 'image' ? source.imageSize : ((source.outputs ?? [])[link.output ?? 0] ?? (source.outputs ?? [])[0])
  return size && size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : null
}

const step = (value: number): number => Math.max(MIN_DIMENSION, Math.round(value / DIMENSION_STEP) * DIMENSION_STEP)

/** A 放大's size: `scale` times the 原图, the long edge kept within MAX_DIMENSION, on the engine's grid. */
export function upscaleSize(size: { width: number; height: number }, scale: number): { width: number; height: number } {
  const width = size.width * scale
  const height = size.height * scale
  const fit = Math.min(1, MAX_DIMENSION / Math.max(width, height))
  return { width: Math.min(MAX_DIMENSION, step(width * fit)), height: Math.min(MAX_DIMENSION, step(height * fit)) }
}

/** A 放大 sized from its 原图 (unchanged when the 原图 or its size is not known yet). */
export function withUpscaleSize(canvas: ProjectCanvas, canvases: readonly ProjectCanvas[]): ProjectCanvas {
  const link = canvas.upscale ? canvas.inputs?.init?.link : undefined
  const size = link ? pictureSize(canvases, link) : null
  if (!canvas.upscale || !size) return canvas
  const target = upscaleSize(size, canvas.upscale.scale)
  return target.width === canvas.width && target.height === canvas.height ? canvas : { ...canvas, ...target }
}

/**
 * A size of `picture`'s shape with about the pixels of `current`, on the
 * engine's grid and within MAX_DIMENSION. Grid sizes rarely match a shape
 * exactly, so of the short edges within 10% of the ideal one it takes the
 * closest shape, then the closest pixel count (4:3 at 1024 × 1024 is 1152 × 864).
 */
export function shapedSize(
  picture: { width: number; height: number },
  current: { width: number; height: number },
): { width: number; height: number } {
  // The search runs over the short edge, so a portrait picture is sized as its landscape twin turned on end.
  if (picture.height > picture.width) {
    const turned = shapedSize({ width: picture.height, height: picture.width }, { width: current.height, height: current.width })
    return { width: turned.height, height: turned.width }
  }
  const ratio = picture.width / picture.height
  const fit = Math.min(1, MAX_DIMENSION / Math.sqrt(current.width * current.height * Math.max(ratio, 1 / ratio)))
  const area = current.width * current.height * fit * fit
  const ideal = Math.sqrt(area / ratio)
  let best = { width: current.width, height: current.height }
  let bestShape = Infinity
  let bestArea = Infinity
  for (let tried = step(ideal * 0.9); tried <= step(ideal * 1.1); tried += DIMENSION_STEP) {
    const height = Math.min(MAX_DIMENSION, tried)
    const width = Math.min(MAX_DIMENSION, step(height * ratio))
    const shape = Math.abs(Math.log(width / height / ratio))
    const off = Math.abs(width * height - area)
    if (shape < bestShape - 1e-9 || (shape <= bestShape + 1e-9 && off < bestArea)) {
      best = { width, height }
      bestShape = shape
      bestArea = off
    }
  }
  return best
}

/**
 * A 画面 that has never run takes the shape of its first 起始图, so the
 * picture is not cropped to the default square. `before` is the 画面 before
 * the link (absent for a new one); a 放大 sizes itself (withUpscaleSize).
 */
export function withStartPictureShape(canvas: ProjectCanvas, canvases: readonly ProjectCanvas[], before?: ProjectCanvas): ProjectCanvas {
  const link = canvas.inputs?.init?.link
  if (canvas.kind !== 'layout' || canvas.upscale || !link || before?.inputs?.init || runsOf(canvas, canvases).length) return canvas
  const size = pictureSize(canvases, link)
  if (!size) return canvas
  const target = shapedSize(size, canvas)
  if (target.width === canvas.width && target.height === canvas.height) return canvas
  // Regions keep their place in the picture: scaled with it, not cut off at the new edges. A 画面 that
  // never had a 起始图 has no 遮罩, so the boxes are the only geometry to carry over.
  const sx = target.width / canvas.width
  const sy = target.height / canvas.height
  const layers = canvas.layers.map((layer) => {
    const [x1, y1, x2, y2] = layer.bbox
    return { ...layer, bbox: [x1 * sx, y1 * sy, x2 * sx, y2 * sy] as ProjectLayer['bbox'] }
  })
  return resizeCanvas({ ...canvas, layers }, target.width, target.height)
}

/** Why a 放大 cannot run yet, beyond what every 画面 checks (resolveJobInputs). */
export function nodeBlockers(canvas: ProjectCanvas, canvases: readonly ProjectCanvas[]): Blocker[] {
  if (!canvas.upscale) return []
  const link = canvas.inputs?.init?.link
  if (!link) return [{ id: 'input-invalid', message: '先给放大接一张原图' }]
  const size = pictureSize(canvases, link)
  if (size) return upscaleRoom(size) ? [] : [{ id: 'input-invalid', message: tooBig(size) }]
  // A picture card from an older version has no recorded pixel size; a picture still being made has none yet.
  const source = linkSourceCanvas(link, canvases)
  if (source?.kind === 'image') return [{ id: 'input-invalid', message: '读不出原图的尺寸，请把这张图重新放进来' }]
  return []
}

/** Whether a picture of this size can still be enlarged. */
export function upscaleRoom(size: { width: number; height: number }): boolean {
  return Math.max(size.width, size.height) < MAX_DIMENSION
}

function tooBig(size: { width: number; height: number }): string {
  return `原图的长边已经有 ${Math.max(size.width, size.height)} 像素，不能再放大了`
}

/** Why a card's picture cannot be enlarged, or null when it can (or its size is not known yet). */
export function upscaleProblem(canvases: readonly ProjectCanvas[], link: CanvasImageLink): string | null {
  const size = pictureSize(canvases, link)
  return size && !upscaleRoom(size) ? tooBig(size) : null
}

/**
 * What a canvas generates with: its description followed by its 风格 nodes',
 * and its LoRA followed by theirs (one already on the canvas keeps its
 * strength). A 放大 without a description takes its 原图's, or a plain
 * "high definition" one, and is sized from its 原图.
 */
export function generationCanvas(canvas: ProjectCanvas, canvases: readonly ProjectCanvas[], depth = 0): ProjectCanvas {
  // A result runs again with what it was made with.
  if (canvas.kind === 'result' && canvas.generated) {
    const made = withDescription(canvas, canvas.generated.prompt)
    return canvas.generated.adapters ? { ...made, adapters: normalizeCanvasAdapters(canvas.generated.adapters) } : made
  }
  if (canvas.kind !== 'layout') return canvas
  let next = withUpscaleSize(canvas, canvases)
  // A 放大 is itself the redraw; it never adds a 高清修复 pass on top.
  if (next.upscale && next.sampling?.hires) {
    const sampling = cleanSampling({ ...next.sampling, hires: undefined })
    next = { ...next, sampling }
    if (!sampling) delete next.sampling
  }
  if (next.upscale && !canvasDescription(next).trim()) {
    const inherited = depth < 4 ? inheritedFrom(next, canvases, depth) : null
    next = withDescription(next, (inherited ? canvasDescription(inherited).trim() : '') || UPSCALE_FALLBACK_PROMPT)
  }
  const styles = stylesOf(next, canvases)
  if (!styles.length) return next
  const texts = styles.map((style) => style.prompt.trim()).filter(Boolean)
  if (texts.length) next = withDescription(next, [canvasDescription(next).trim(), ...texts].filter(Boolean).join('，'))
  const own = normalizeCanvasAdapters(next.adapters)
  const added = styles.flatMap((style) => normalizeCanvasAdapters(style.adapters))
  const merged = [...own]
  for (const adapter of added) if (!merged.some((item) => item.id === adapter.id)) merged.push(adapter)
  return { ...next, adapters: normalizeCanvasAdapters(merged) }
}

/**
 * What a 放大's 原图 was generated with (its 风格 included), or null for a
 * picture card: a 放大 without a description of its own uses that.
 */
function inheritedFrom(canvas: ProjectCanvas, canvases: readonly ProjectCanvas[], depth = 0): ProjectCanvas | null {
  const link = canvas.inputs?.init?.link
  const source = link ? linkSourceCanvas(link, canvases) : undefined
  if (!source || (source.kind !== 'layout' && source.kind !== 'result')) return null
  return generationCanvas(source, canvases, depth + 1)
}

/**
 * The snapshot a run keeps of what it was generated with (see
 * ProjectCanvas.generated), or undefined when that is just its own
 * description and LoRA.
 */
export function generatedSnapshot(own: ProjectCanvas, generating: ProjectCanvas): ProjectCanvas['generated'] {
  const prompt = canvasDescription(generating)
  const adapters = normalizeCanvasAdapters(generating.adapters)
  const sameAdapters = JSON.stringify(adapters) === JSON.stringify(normalizeCanvasAdapters(own.adapters))
  if (prompt === canvasDescription(own) && sameAdapters) return undefined
  return sameAdapters ? { prompt } : { prompt, adapters }
}

/**
 * Where LoRA the canvas does not list itself come from, for a blocker that
 * says to remove a LoRA: "（其中有风格「水彩」里的）", or '' when all are its own.
 */
export function styleLoraNote(own: ProjectCanvas, canvases: readonly ProjectCanvas[]): string {
  const mine = new Set(normalizeCanvasAdapters(own.adapters).map((adapter) => adapter.id))
  const styles = stylesOf(own, canvases).filter((style) => normalizeCanvasAdapters(style.adapters).some((adapter) => !mine.has(adapter.id)))
  return styles.length ? `（其中有${styles.map((style) => `风格「${style.title}」`).join('、')}里的）` : ''
}

/** A new, empty 风格 node in the first free spot (or at `at`). */
export function createStyleCanvas(
  existing: readonly ProjectCanvas[],
  options: { at?: { x: number; y: number }; id?: string } = {},
): ProjectCanvas {
  const spot = options.at ?? nextFreeSpot(boardCanvases(existing), STYLE_CARD)
  return {
    id: options.id ?? crypto.randomUUID(),
    kind: 'style',
    title: nextNodeTitle(
      '风格',
      existing.map((item) => item.title),
    ),
    x: Math.round(spot.x),
    y: Math.round(spot.y),
    width: STYLE_CARD.width,
    height: STYLE_CARD.height,
    summary: { caption: '', meta: [], canvas: 'single' },
    layers: [],
    prompt: '',
    negative: '',
    seed: 0,
    steps: 1,
    cfg: 0,
    adapters: [],
  }
}

/**
 * 放大: a 放大 node to the right of a card (or at `at`), fed by its picture
 * (a 画面 gives the one on its face; a filmstrip run used so is pinned).
 * `fallback` = the settings a picture card's 放大 starts with.
 */
export function upscaleFromPicture(
  canvases: readonly ProjectCanvas[],
  sourceId: string,
  options: { fallback: CanvasSettings; at?: { x: number; y: number }; id?: string },
): { canvases: ProjectCanvas[]; created: ProjectCanvas } | null {
  const source = canvases.find((canvas) => canvas.id === sourceId)
  if (!source || !givesPicture(source, canvases)) return null
  const link = pictureLink(canvases, { canvasId: sourceId })
  if (upscaleProblem(canvases, link)) return null
  const pinned = pinRun(canvases, link.canvasId)
  // The 原图's run: its settings, and the LoRA it was really made with (a 风格's included).
  const origin = linkSourceCanvas(link, canvases) ?? source
  const settings = source.kind === 'image' ? options.fallback : settingsFrom(source)
  const made = origin.kind === 'image' ? null : generationCanvas(origin, canvases)
  const base = createLayoutCanvas(
    pinned,
    { ...settings, sampling: undefined, ...(made ? { adapters: normalizeCanvasAdapters(made.adapters) } : {}) },
    options.id,
  )
  let created: ProjectCanvas = {
    ...base,
    title: nextNodeTitle(
      '放大',
      pinned.map((item) => item.title),
    ),
    upscale: { scale: 2 },
  }
  delete created.sampling
  created = setLink(created, 'init', link)
  created = {
    ...created,
    inputs: { ...created.inputs, init: { ...created.inputs!.init!, strength: UPSCALE_DETAIL_DEFAULT, resize: 'stretch' } },
  }
  created = withUpscaleSize(created, pinned)
  const spot = options.at ? { x: Math.round(options.at.x), y: Math.round(options.at.y) } : spotBeside(source, created, pinned)
  created = { ...created, x: spot.x, y: spot.y }
  return { canvases: [...pinned, created], created }
}

/** Set a 放大's scale (its size follows its 原图). */
export function withUpscaleScale(canvas: ProjectCanvas, scale: number, canvases: readonly ProjectCanvas[]): ProjectCanvas {
  if (!canvas.upscale) return canvas
  return withUpscaleSize({ ...canvas, upscale: { scale } }, canvases)
}

/**
 * 一组同风格的图: a 风格 and three 画面 wired to it, side by side. Each
 * 画面 is described on its own; the 风格 carries what they share.
 */
export function seriesFromStyle(
  existing: readonly ProjectCanvas[],
  settings: CanvasSettings,
): { canvases: ProjectCanvas[]; style: ProjectCanvas; layouts: ProjectCanvas[] } {
  const style = createStyleCanvas(existing)
  let list: ProjectCanvas[] = [...existing, style]
  const layouts: ProjectCanvas[] = []
  for (let index = 0; index < 3; index += 1) {
    const near = layouts.at(-1) ?? style
    const placed = createLayoutCanvas(list, settings)
    const spot = spotBeside(index === 0 ? style : { ...near, y: style.y }, settings, list)
    const layout = setLink({ ...placed, x: spot.x, y: spot.y }, 'style', { canvasId: style.id })
    layouts.push(layout)
    list = [...list, layout]
  }
  return { canvases: list, style, layouts }
}

/**
 * 在创作中试用 (训练 › 完成): a 风格 named after the training that holds its
 * LoRA at full strength, and a new 画面 wired to it whose description is a
 * sample prompt (it carries the trigger word), side by side in free spots.
 */
export function tryLoraOnBoard(
  existing: readonly ProjectCanvas[],
  settings: CanvasSettings,
  lora: { name: string; adapterId: string; prompt: string },
): { canvases: ProjectCanvas[]; style: ProjectCanvas; layout: ProjectCanvas } {
  const style: ProjectCanvas = {
    ...createStyleCanvas(existing),
    title:
      lora.name.trim() ||
      nextNodeTitle(
        '风格',
        existing.map((item) => item.title),
      ),
    adapters: normalizeCanvasAdapters([{ id: lora.adapterId, strength: 1 }]),
  }
  const withStyle = [...existing, style]
  // The 画面 tries this LoRA alone; LoRA the copied settings carried would muddle the result.
  const placed = withDescription(createLayoutCanvas(withStyle, { ...settings, adapters: [] }), lora.prompt.trim())
  const spot = spotBeside(style, placed, withStyle)
  const layout = setLink({ ...placed, x: spot.x, y: spot.y }, 'style', { canvasId: style.id })
  return { canvases: [...withStyle, layout], style, layout }
}
