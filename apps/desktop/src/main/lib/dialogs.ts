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
