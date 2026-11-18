/**
 * 界面大小: how large text and controls are drawn. 自动 grows them with the
 * window from its default size, so a maximized window on a large screen is
 * not a sea of small text; a fixed size keeps them there. Main applies the
 * result as the window's zoom factor. No Node or DOM imports.
 */

export const UI_SCALES = ['auto', '100', '110', '125', '150'] as const
export type UiScale = (typeof UI_SCALES)[number]

/** The window size the layout is drawn for at 100 % (the window's default size). */
const BASE = { width: 1600, height: 1000 }
/** The smallest layout the pages hold (the window's minimum size): zoom never squeezes the page below it. */
const MIN_LAYOUT = { width: 1024, height: 640 }
const AUTO_MAX = 1.5
/** Zoom moves in steps, so resizing a window does not lay the page out again at every pixel. */
const STEP = 0.05

/** The zoom factor for a window whose content area is `size` (in DIPs). */
export function uiZoomFactor(scale: UiScale, size: { width: number; height: number }): number {
  const wanted =
    scale === 'auto' ? Math.min(AUTO_MAX, Math.max(1, Math.min(size.width / BASE.width, size.height / BASE.height))) : Number(scale) / 100
  // The page must still have its minimum size in CSS pixels; a window smaller than that stays at 100 %.
  const room = Math.min(size.width / MIN_LAYOUT.width, size.height / MIN_LAYOUT.height)
  const factor = Math.max(1, Math.min(wanted, room))
  return Math.round(Math.floor(factor / STEP + 1e-9) * STEP * 100) / 100
}
