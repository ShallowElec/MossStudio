import { Check, ChevronDown, FolderOutput, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { GalleryExportProgress, GalleryExportResult } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { MenuItem, Popover } from '../../components/common/Popover'
import { Button, ConfirmDialog, IconButton, ProgressBar, cn, useToast } from '../../components/ui'
import { trashName } from './DetailPanel'

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** How long an export runs before its progress shows; a few pictures are done before that. */
const PROGRESS_DELAY_MS = 400

/**
 * The bar that takes the detail panel's place while several pictures are
 * picked: 导出到文件夹… (only the pictures, or with their 生成参数), 删除 and
 * 取消选择. There is no 复制: several files on the clipboard do not paste the
 * same way on every system.
 */
export function SelectionBar({
  paths,
  onClear,
  onDeleted,
  onExporting,
}: {
  /** The picked pictures, in listing order. */
  paths: readonly string[]
  onClear: () => void
  onDeleted: (paths: string[]) => void
  /** The pictures being exported, then null: the page keeps the bar while they copy, even if the picks change. */
  onExporting: (paths: readonly string[] | null) => void
}): React.JSX.Element {
  const toast = useToast()
  const [withParams, setWithParams] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState<GalleryExportProgress | null>(null)
  const [slow, setSlow] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const count = paths.length

  const copying = progress !== null
  useEffect(() => {
    if (!copying) return
    const timer = window.setTimeout(() => setSlow(true), PROGRESS_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [copying])

  const exportPictures = async (): Promise<void> => {
    setExporting(true)
    onExporting(paths)
    // Progress starts once a folder is picked; until then the dialog is up.
    const off = onEvent<GalleryExportProgress>(Events.galleryExport, setProgress)
    try {
      const result = await call<GalleryExportResult | null>(Ipc.galleryExport, { paths, withParams })
      if (!result) return
      if (result.failed) toast.push(`已导出 ${result.exported} 张，${result.failed} 张没能导出（文件可能已被移动或删除）`, 'error')
      else toast.push(`已导出 ${result.exported} 张`, 'success')
    } catch (cause) {
      toast.push(`没能导出：${message(cause)}`, 'error')
    } finally {
      off()
      onExporting(null)
      setExporting(false)
      setProgress(null)
      setSlow(false)
    }
  }

  const remove = async (): Promise<void> => {
    setConfirming(false)
    setDeleting(true)
    const removed: string[] = []
    let failure: string | null = null
    for (const path of paths) {
      try {
        await call(Ipc.galleryTrash, { path })
        removed.push(path)
      } catch (cause) {
        failure ??= message(cause)
      }
    }
    setDeleting(false)
    if (removed.length) {
      onDeleted(removed)
      toast.push(`已把 ${removed.length} 张移到${trashName()}`, 'success')
    }
    if (failure) toast.push(`有 ${count - removed.length} 张没能删除：${failure}`, 'error')
  }

  const shown = slow && progress && progress.total > 0 ? progress : null

  return (
    <div
      role="toolbar"
      aria-label="已选作品"
      data-library-selection
      className="pointer-events-auto flex items-center gap-2 rounded-xl bg-raised py-1.5 pl-4 pr-1.5 text-ink shadow-float"
    >
      <span className="tabular whitespace-nowrap text-ui font-medium">已选 {count} 张</span>
      {shown ? (
        <div className="flex w-40 items-center gap-2" aria-live="polite">
          <ProgressBar value={(shown.done / shown.total) * 100} label="导出进度" />
          <span className="tabular whitespace-nowrap text-caption text-ink-2">
            {shown.done} / {shown.total}
          </span>
        </div>
      ) : null}
      <div className="ml-2 flex items-center gap-px">
        <Button tone="primary" className="rounded-r-none" disabled={exporting || deleting} onClick={() => void exportPictures()}>
          <FolderOutput className="size-4" strokeWidth={1.6} /> 导出到文件夹…
        </Button>
        <Popover
          align="end"
          label="导出内容"
          // The bar sits at the bottom of the window: the menu opens upwards.
          className="bottom-full top-auto mb-1.5 mt-0"
          trigger={(menu) => (
            <Button
              tone="primary"
              className="rounded-l-none px-1.5"
              aria-label="导出内容"
              title="导出内容"
              disabled={exporting || deleting}
              aria-expanded={menu['aria-expanded']}
              aria-haspopup={menu['aria-haspopup']}
              aria-controls={menu['aria-controls']}
              onClick={menu.toggle}
            >
              <ChevronDown className="size-4" strokeWidth={1.6} />
            </Button>
          )}
        >
          {(close) =>
            (
              [
                [false, '只导出图片'],
                [true, '连同生成参数'],
              ] as const
            ).map(([value, label]) => (
              <MenuItem
                key={label}
                selected={withParams === value}
                onSelect={() => {
                  setWithParams(value)
                  close()
                }}
              >
                <span className="flex items-center gap-2">
                  <Check className={cn('size-4 shrink-0', withParams !== value && 'invisible')} strokeWidth={1.6} aria-hidden="true" />
                  {label}
                </span>
              </MenuItem>
            ))
          }
        </Popover>
      </div>
      <Button tone="ghost-danger" disabled={exporting || deleting} onClick={() => setConfirming(true)}>
        <Trash2 className="size-4" strokeWidth={1.6} /> 删除
      </Button>
      <IconButton label="取消选择（Esc）" onClick={onClear}>
        <X className="size-4" strokeWidth={1.6} />
      </IconButton>

      <ConfirmDialog
        open={confirming}
        title={`删除这 ${count} 张图片？`}
        description={`它们会移到系统${trashName()}，需要时可以从那里恢复。`}
        confirmLabel={`移到${trashName()}`}
        onClose={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    </div>
  )
}
