import { create } from 'zustand'
import { Ipc } from '@shared/channels'
import type { ModelImportState } from '@shared/types'
import { call } from './api'

/**
 * 导入模型 in the renderer: the import main runs (kept current by its events)
 * and whether its sheet is open. Every way in — the 模型 page's button, a drop
 * on the window or the board, first-run setup — goes through here.
 */
interface ModelImportStore {
  state: ModelImportState | null
  open: boolean
  setState: (state: ModelImportState | null) => void
  /** Files and folders dropped on the window; the sheet opens on them. */
  start: (paths: string[]) => Promise<void>
  /** 选择文件… / 选择文件夹…: nothing happens when the dialog is canceled. */
  pick: (kind: 'files' | 'folder') => Promise<void>
  /** Opens the sheet: on the import running, else on its two buttons. */
  show: () => void
  /** 在后台继续 / 留在这里: the import goes on without the sheet. */
  close: () => void
}

export const useModelImport = create<ModelImportStore>((set) => ({
  state: null,
  open: false,
  setState: (state) => set({ state }),
  async start(paths) {
    const state = await call<ModelImportState>(Ipc.modelsImport, { paths })
    set({ state, open: true })
  },
  async pick(kind) {
    const state = await call<ModelImportState | null>(Ipc.modelsImportPick, { kind })
    if (state) set({ state, open: true })
  },
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}))

/** Disk paths of dropped files; a file the bridge cannot name (a paste, a browser file) is left out. */
export function droppedPaths(files: FileList | readonly File[] | null | undefined): string[] {
  return [...(files ?? [])].map((file) => window.clover.pathForFile?.(file) ?? '').filter(Boolean)
}
