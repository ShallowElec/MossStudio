import { BrowserWindow, dialog } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { showOpenDialogFor } from '@main/lib/dialogs'

afterEach(() => {
  vi.restoreAllMocks()
  ;(BrowserWindow as unknown as { reset: () => void }).reset()
})

describe('main/lib/dialogs', () => {
  it('attaches the open dialog to the window that asked, so it is modal there', async () => {
    const open = vi.spyOn(dialog, 'showOpenDialog')
    const window = new BrowserWindow()
    const options = { title: '选择起始图', properties: ['openFile' as const] }
    await showOpenDialogFor(window.webContents, options)
    expect(open).toHaveBeenCalledWith(window, options)
  })

  it('opens it on its own when that window is gone', async () => {
    const open = vi.spyOn(dialog, 'showOpenDialog')
    const sender = new BrowserWindow().webContents
    ;(BrowserWindow as unknown as { reset: () => void }).reset()
    await showOpenDialogFor(sender, { title: '选择图片' })
    expect(open).toHaveBeenCalledWith({ title: '选择图片' })
  })
})
