/** Legacy names are UI intents now; the main window is the only OS window. */
export type WindowKind = 'studio' | 'launcher' | 'creator' | 'terminal' | 'devices'

export interface WindowIntent {
  target: 'studio' | 'management' | 'terminal'
  route?: string
}

export function openWindow(kind: WindowKind, route?: string): void {
  const intent: WindowIntent =
    kind === 'terminal'
      ? { target: 'terminal' }
      : kind === 'creator'
        ? { target: 'studio', route: route ?? '/studio' }
        : kind === 'launcher'
          ? { target: 'management', route: route ?? '/settings' }
          : kind === 'devices'
            ? { target: 'management', route: '/devices' }
            : { target: 'studio', route: '/studio' }
  window.dispatchEvent(new CustomEvent<WindowIntent>('mossstudio:window-intent', { detail: intent }))
}
