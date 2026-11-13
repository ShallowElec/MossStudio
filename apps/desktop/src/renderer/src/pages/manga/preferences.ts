/** The model the Studio last picked (StudioPage's BUNDLE_KEY); a series without its own model uses it too. */
const BUNDLE_KEY = 'mossstudio.modelBundleId'
const OPEN_KEY = 'mossstudio.manga.open'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // Private storage: only the convenience is lost.
  }
}

export const readPreferredBundle = (): string | null => read(BUNDLE_KEY)

/** The series that was open last, reopened when the page is visited again. */
export const readOpenSeries = (): string | null => read(OPEN_KEY)
export const writeOpenSeries = (id: string | null): void => write(OPEN_KEY, id)
