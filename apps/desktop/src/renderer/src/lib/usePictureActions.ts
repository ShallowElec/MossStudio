import { useMemo } from 'react'
import { Ipc } from '@shared/channels'
import type { GallerySaveResult } from '@shared/types'
import { useToast } from '../components/ui'
import { call } from './api'

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export type PictureMenuEntry = { label: string; onSelect: () => void } | { gap: true }

export interface PictureActions {
  /** Puts the picture on the clipboard; false (after a toast) when that failed. */
  copy: (path: string) => Promise<boolean>
  saveAs: (path: string) => Promise<void>
  reveal: (path: string) => void
  /** Hands the pictures to the drag the pointer is making, so another app can take them. */
  dragOut: (paths: readonly string[]) => void
  /** The right-click menu of one picture. */
  menu: (path: string) => PictureMenuEntry[]
}

/** What can be done with a generated picture outside MossStudio, the same in the viewer, 作品 and the filmstrip. */
export function usePictureActions(): PictureActions {
  const toast = useToast()
  return useMemo(() => {
    const fail = (cause: unknown): void => toast.push(message(cause), 'error')
    const copy = async (path: string): Promise<boolean> => {
      try {
        await call(Ipc.galleryCopyImage, { path })
        return true
      } catch (cause) {
        fail(cause)
        return false
      }
    }
    const saveAs = async (path: string): Promise<void> => {
      try {
        const saved = await call<GallerySaveResult | null>(Ipc.gallerySaveAs, { path })
        if (saved) toast.push('已保存', 'success')
      } catch (cause) {
        fail(cause)
      }
    }
    const reveal = (path: string): void => void call(Ipc.galleryReveal, { path }).catch(fail)
    const dragOut = (paths: readonly string[]): void => {
      if (paths.length) void call(Ipc.galleryStartDrag, { paths }).catch(fail)
    }
    const menu = (path: string): PictureMenuEntry[] => [
      {
        label: '复制图片',
        onSelect: () =>
          void copy(path).then((done) => {
            if (done) toast.push('已复制图片', 'success')
          }),
      },
      { label: '另存为…', onSelect: () => void saveAs(path) },
      { gap: true },
      { label: '在文件夹中显示', onSelect: () => reveal(path) },
    ]
    return { copy, saveAs, reveal, dragOut, menu }
  }, [toast])
}
