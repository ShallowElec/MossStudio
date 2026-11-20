import { BrowserWindow, dialog } from 'electron'

/**
 * An open-file dialog attached to the window that asked for it, so it is modal
 * there: nothing behind it (another project, say) changes while it is up.
 * When the window is gone it stands alone.
 */
export function showOpenDialogFor(
  sender: Electron.WebContents,
  options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  const owner = BrowserWindow.fromWebContents(sender)
  return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options)
}

/** A save dialog attached to the window that asked for it, like `showOpenDialogFor`. */
export function showSaveDialogFor(
  sender: Electron.WebContents,
  options: Electron.SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> {
  const owner = BrowserWindow.fromWebContents(sender)
  return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options)
}
