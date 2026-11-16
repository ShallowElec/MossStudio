import { afterEach, describe, expect, it } from 'vitest'
import { openWindow, type WindowIntent, type WindowKind } from '@renderer/lib/windows'
import { createMockBackend, type MockBackend } from '../../mocks/backend'

let uninstall: () => void = () => undefined
afterEach(() => uninstall())

function setup(): { backend: MockBackend; intents: WindowIntent[] } {
  const backend = createMockBackend('ready', { bridge: { windowKind: 'launcher' } })
  const intents: WindowIntent[] = []
  const listener = (event: Event): void => {
    intents.push((event as CustomEvent<WindowIntent>).detail)
  }
  window.addEventListener('mossstudio:window-intent', listener)
  const restore = backend.install()
  uninstall = () => {
    restore()
    window.removeEventListener('mossstudio:window-intent', listener)
  }
  return { backend, intents }
}

describe('lib/windows openWindow', () => {
  it.each<[WindowKind, string | undefined, WindowIntent]>([
    ['terminal', '/ignored', { target: 'terminal' }],
    ['creator', undefined, { target: 'studio', route: '/studio' }],
    ['creator', '/studio?x=1', { target: 'studio', route: '/studio?x=1' }],
    ['launcher', undefined, { target: 'management', route: '/settings' }],
    ['launcher', '/models', { target: 'management', route: '/models' }],
    ['devices', '/ignored', { target: 'management', route: '/devices' }],
    ['studio', '/ignored', { target: 'studio', route: '/studio' }],
  ])('maps %s (%s) to an in-window intent', (kind, route, intent) => {
    const { backend, intents } = setup()
    openWindow(kind, route)
    expect(intents).toEqual([intent])
    expect(backend.calls).toEqual([])
  })
})
