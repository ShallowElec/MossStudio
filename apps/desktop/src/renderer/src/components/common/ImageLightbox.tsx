import { Copy, Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { Ipc } from '@shared/channels'
import { ApiError, call } from '../../lib/api'
import { cloverUrl } from '../../lib/clover'
import { usePictureActions } from '../../lib/usePictureActions'
import { Button, IconButton, Modal, ToastProvider, cn, useToast } from '../ui'

interface Picture {
  path: string
  /** A live preview file is rewritten in place; keep the frame that was on the card. */
  seq?: number
  /** Shown as given: a card title, a prompt, a label. */
  title?: string
  /** A file name, shown when there is no title; folders in it are never shown. */
  name?: string
  width?: number
  height?: number
  /** Generated artwork supports native copy and save; imported assets are preview-only files. */
  artwork?: boolean
  /** Shown and copied in grayscale, as a monochrome manga series shows and exports its panels. */
  grayscale?: boolean
}
interface Preview extends Picture {
  gallery?: readonly Picture[]
}
const usePreview = create<{ images: Picture[]; index: number }>(() => ({ images: [], index: 0 }))
const close = (): void => usePreview.setState({ images: [], index: 0 })
export const isRasterData = (src: string): boolean => /^data:image\/(?:png|jpeg|webp|gif|bmp|avif);base64,/i.test(src)
// Our own coded errors are written for people; anything else may carry a raw path.
const previewError = (cause: unknown): string =>
  cause instanceof ApiError && cause.code.startsWith('E_') ? cause.message : '图片复制或保存失败，请确认图片仍可读取。'
const label = ({ title, name }: Picture): string | undefined => title ?? name?.split(/[\\/]/).at(-1)
const allowed = ({ path }: Picture): boolean => isRasterData(path) || /^(?:[a-z]:[\\/]|\/(?![\\/]))/i.test(path)

export function openImagePreview(request: Preview): void {
  if (!allowed(request)) return
  const images = (request.gallery ?? []).filter(allowed)
  let index = images.findIndex((image) => image.path === request.path)
  if (index < 0) index = images.push(request) - 1
  usePreview.setState({ images: images.map((image) => ({ ...image, title: label(image) })), index })
}

export function PreviewButton({
  children,
  className,
  ...request
}: Preview & { children: ReactNode; className?: string }): React.JSX.Element {
  const title = label(request)
  return (
    <button
      type="button"
      aria-label={`放大预览${title ? `：${title}` : ''}`}
      className={cn('block size-full cursor-zoom-in', className)}
      onClick={() => openImagePreview(request)}
    >
      {children}
    </button>
  )
}

async function copyPixels(image: HTMLImageElement | null, grayscale = false): Promise<void> {
  const canvas = document.createElement('canvas')
  canvas.width = image?.naturalWidth ?? 0
  canvas.height = image?.naturalHeight ?? 0
  const context = canvas.getContext('2d')
  if (!image || !context || !canvas.width || !canvas.height) throw new Error('Image unavailable')
  if (grayscale) context.filter = 'grayscale(1)'
  context.drawImage(image, 0, 0)
  const png = new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG unavailable'))), 'image/png'),
  )
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

function PictureView({ picture, step }: { picture: Picture; step: (offset: number) => void }): React.JSX.Element {
  const image = useRef<HTMLImageElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [zoom, setZoom] = useState<number | null>(null),
    [natural, setNatural] = useState(picture.width ?? 0)
  const [failed, setFailed] = useState(false)
  const toast = useToast(),
    pictures = usePictureActions(previewError)
  const data = isRasterData(picture.path),
    artwork = !data && picture.artwork
  const scale = (to: (zoom: number) => number): void =>
    setZoom((value) => Math.max(0.25, Math.min(4, to(value ?? ((image.current?.width || natural) / natural || 1)))))
  const copy = async (): Promise<void> => {
    try {
      if (artwork && !picture.grayscale) {
        try {
          await call(Ipc.galleryCopyImage, { path: picture.path })
        } catch (cause) {
          // Main reads fewer formats than Chromium (WebP on some systems), and the picture on screen is already decoded.
          if (!(cause instanceof ApiError && cause.code === 'E_IMAGE_FORMAT')) throw cause
          await copyPixels(image.current).catch(() => Promise.reject(cause))
        }
      } else await copyPixels(image.current, picture.grayscale)
      toast.push('已复制图片', 'success')
    } catch (cause) {
      toast.push(artwork ? previewError(cause) : '没能复制图片，请确认图片已加载后再试。', 'error')
    }
  }
  useEffect(() => {
    const el = stage.current
    const onWheel = (e: WheelEvent): void => {
      if (!e.deltaY) return
      // Non-passive, unlike React's wheel listener, so the zoomed picture does not also scroll.
      e.preventDefault()
      // In proportion to the distance: a wheel notch is about 100 px, a trackpad flick many small steps.
      scale((zoom) => zoom * Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) / 400))
    }
    el?.addEventListener('wheel', onWheel, { passive: false })
    return () => el?.removeEventListener('wheel', onWheel)
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // While the dialog animates out it still shows this picture, but no longer takes keys.
      if (!usePreview.getState().images.length) return
      const dialogs = document.querySelectorAll('dialog[open]')
      if (stage.current?.closest('dialog') !== dialogs[dialogs.length - 1]) return
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') step(e.key === 'ArrowLeft' ? -1 : 1)
      else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
        if (!e.repeat) void copy()
      } else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div
        ref={stage}
        data-preview-stage
        className="min-h-0 flex-1 overflow-auto rounded-lg bg-well"
        onClick={(e) => {
          if (e.target === e.currentTarget) close()
        }}
      >
        <div
          className="pointer-events-none flex size-max min-h-full min-w-full items-center justify-center"
          style={zoom === null ? { width: '100%', height: '100%' } : undefined}
        >
          {failed ? (
            <span className="text-ui text-ink-2">图片无法显示，可能已移走或格式不支持。</span>
          ) : (
            <img
              ref={image}
              crossOrigin="anonymous"
              draggable={false}
              alt={picture.title || '图片预览'}
              src={data ? picture.path : cloverUrl(picture.path, picture.seq)}
              className={cn(
                'pointer-events-auto block select-none',
                picture.grayscale && 'grayscale',
                zoom === null ? 'max-h-full max-w-full' : 'max-w-none cursor-grab active:cursor-grabbing',
              )}
              style={zoom !== null && natural ? { width: natural * zoom } : undefined}
              onLoad={(e) => setNatural(e.currentTarget.naturalWidth)}
              onError={() => setFailed(true)}
              onPointerDown={(e) => {
                const el = stage.current
                if (zoom === null || !el || e.button !== 0) return
                drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={(e) => {
                const d = drag.current
                if (d && stage.current) stage.current.scrollTo(d.left + d.x - e.clientX, d.top + d.y - e.clientY)
              }}
              onLostPointerCapture={() => {
                drag.current = null
              }}
            />
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2" aria-label="图片操作">
        <IconButton label="缩小" onClick={() => scale((zoom) => zoom - 0.25)}>
          <Minus className="size-4" strokeWidth={1.6} />
        </IconButton>
        <span className="tabular text-caption text-ink-2">{zoom === null ? '适应' : `${Math.round(zoom * 100)}%`}</span>
        <IconButton label="放大" onClick={() => scale((zoom) => zoom + 0.25)}>
          <Plus className="size-4" strokeWidth={1.6} />
        </IconButton>
        <Button onClick={() => setZoom(1)}>100%</Button>
        <Button onClick={() => setZoom(null)}>适应屏幕</Button>
        {artwork ? <Button onClick={() => void pictures.saveAs(picture.path)}>另存为…</Button> : null}
        <Button tone="primary" onClick={() => void copy()}>
          <Copy className="size-4" strokeWidth={1.6} />
          复制图片
        </Button>
      </div>
    </div>
  )
}

export function ImageLightbox(): React.JSX.Element {
  const { images, index } = usePreview(),
    picture = images[index]
  // The shell keys this host by route, including navigation through React Router's history API.
  useEffect(() => close, [])
  const step = (offset: number): void => usePreview.setState({ index: (index + offset + images.length) % images.length })
  return (
    <Modal
      open={Boolean(picture)}
      onClose={close}
      title={`${picture?.title || '图片预览'}${images.length > 1 ? ` · ${index + 1} / ${images.length}` : ''}`}
      width="h-full max-h-full max-w-none [&>div]:overflow-hidden"
    >
      <ToastProvider>{picture ? <PictureView key={picture.path} picture={picture} step={step} /> : null}</ToastProvider>
    </Modal>
  )
}
