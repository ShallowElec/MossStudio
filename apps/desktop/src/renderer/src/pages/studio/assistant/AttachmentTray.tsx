import { ImagePlus, X } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { isRasterData, PreviewButton } from '../../../components/common/ImageLightbox'
import { Button, IconButton } from '../../../components/ui'
import type { CollabAttachment } from './collabClient'

export const MAX_ATTACHMENTS = 4
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

export interface TrayImage extends CollabAttachment {
  id: string
  size: number
  dataUrl: string
}

/** The files that fit (pictures, ≤ 8 MB, at most 4 in all) and the first reason something did not. */
export function planAttachments(
  existing: number,
  files: ReadonlyArray<{ name: string; type: string; size: number }>,
): { accepted: number[]; problem: string | null } {
  const accepted: number[] = []
  let problem: string | null = null
  files.forEach((file, index) => {
    if (!file.type.startsWith('image/')) {
      problem ??= `「${file.name}」不是图片，只能附带图片。`
      return
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      problem ??= `「${file.name}」超过 8 MB，换一张小一点的图片。`
      return
    }
    if (existing + accepted.length >= MAX_ATTACHMENTS) {
      problem ??= `最多附带 ${MAX_ATTACHMENTS} 张图片。`
      return
    }
    accepted.push(index)
  })
  return { accepted, problem }
}

/** Image files carried by a paste or a drop; text-only clipboards give none. */
export function imageFilesOf(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = Array.from(data.files ?? [])
  if (files.length) return files.filter((file) => file.type.startsWith('image/'))
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取图片失败')))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

export interface AttachmentState {
  items: TrayImage[]
  problem: string | null
  add: (files: readonly File[]) => Promise<void>
  remove: (id: string) => void
  clear: () => void
}

export function useAttachments(): AttachmentState {
  const [items, setItems] = useState<TrayImage[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const count = useRef(0)
  count.current = items.length
  /** Pictures still being read, so a second paste before the read ends cannot pass the limit. */
  const pending = useRef(0)

  const add = useCallback(async (files: readonly File[]) => {
    const { accepted, problem: reason } = planAttachments(count.current + pending.current, files)
    setProblem(reason)
    if (!accepted.length) return
    pending.current += accepted.length
    const read = await Promise.all(
      accepted.map(async (index): Promise<TrayImage | null> => {
        const file = files[index]!
        try {
          const dataUrl = await readDataUrl(file)
          return { id: crypto.randomUUID(), name: file.name || '粘贴的图片.png', mime: file.type, size: file.size, dataUrl }
        } catch {
          return null
        }
      }),
    )
    pending.current -= accepted.length
    const ok = read.filter((item): item is TrayImage => item !== null)
    if (ok.length < accepted.length) setProblem('有图片没能读取，请重新选择。')
    setItems((current) => [...current, ...ok].slice(0, MAX_ATTACHMENTS))
  }, [])

  const remove = useCallback((id: string) => {
    setProblem(null)
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])
  const clear = useCallback(() => {
    setProblem(null)
    setItems([])
  }, [])
  return { items, problem, add, remove, clear }
}

/** Thumbnails of the pictures going with the next message, and the button to pick more. */
export function AttachmentTray({ state, disabled }: { state: AttachmentState; disabled?: boolean }): React.JSX.Element {
  const picker = useRef<HTMLInputElement>(null)
  const full = state.items.length >= MAX_ATTACHMENTS
  const gallery = state.items.filter((item) => isRasterData(item.dataUrl)).map((item) => ({ path: item.dataUrl, name: item.name }))
  return (
    <div className="flex min-w-0 flex-col gap-1" data-attachment-tray>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {state.items.map((item) => (
          <div key={item.id} className="relative size-11 shrink-0 overflow-hidden rounded-md bg-well" data-attachment={item.name}>
            {isRasterData(item.dataUrl) ? (
              <PreviewButton path={item.dataUrl} name={item.name} gallery={gallery}>
                <img src={item.dataUrl} alt={item.name} className="size-full object-cover" draggable={false} />
              </PreviewButton>
            ) : (
              <img src={item.dataUrl} alt={item.name} className="size-full object-cover" draggable={false} />
            )}
            <IconButton
              label={`移除图片 ${item.name}`}
              onClick={() => state.remove(item.id)}
              className="absolute right-0.5 top-0.5 size-4 rounded bg-raised text-ink-2 shadow-float enabled:hover:bg-raised"
            >
              <X className="size-3" strokeWidth={1.6} />
            </IconButton>
          </div>
        ))}
        <Button
          tone="ghost"
          size="xs"
          disabled={disabled || full}
          title={full ? `最多附带 ${MAX_ATTACHMENTS} 张图片` : '也可以直接粘贴截图，或把图片拖到输入框'}
          onClick={() => picker.current?.click()}
          data-attach-image
        >
          <ImagePlus className="size-3.5" aria-hidden="true" strokeWidth={1.6} />
          附带图片
        </Button>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="选择要附带的图片"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            void state.add(files)
          }}
        />
      </div>
      {state.problem ? (
        <p role="status" className="text-caption text-danger">
          {state.problem}
        </p>
      ) : null}
    </div>
  )
}
