import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProjectCanvas } from '@shared/types'
import { canvasFixture } from '@test/mocks/backend'
import { ImageLightbox } from '@renderer/components/common/ImageLightbox'
import { CanvasCard, sameCardProps, type CanvasCardProps } from '@renderer/pages/studio/CanvasCard'
import { sameData } from '@renderer/pages/studio/sameData'
import { useCardDrag } from '@renderer/pages/studio/useCardDrag'
import { useStableCallbacks } from '@renderer/pages/studio/useStableCallbacks'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

function mount<P>(useHook: (props: P) => unknown, first: P): { current: () => unknown; rerender: (props: P) => void } {
  let value: unknown
  function Probe(props: { value: P }): null {
    value = useHook(props.value)
    return null
  }
  root = createRoot(document.createElement('div'))
  act(() => root!.render(createElement(Probe, { value: first })))
  return {
    current: () => value,
    rerender: (props) => act(() => root!.render(createElement(Probe, { value: props }))),
  }
}

describe('studio/sameData', () => {
  it('compares plain data by value', () => {
    expect(sameData({ a: [1, { b: 'x' }], c: null }, { a: [1, { b: 'x' }], c: null })).toBe(true)
    expect(sameData(new Map([['k', { n: 1 }]]), new Map([['k', { n: 1 }]]))).toBe(true)
    expect(sameData(new Set(['a']), new Set(['a']))).toBe(true)
    expect(sameData({ a: [1, 2] }, { a: [1, 3] })).toBe(false)
    expect(sameData({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(sameData(new Map([['k', 1]]), new Map([['k', 2]]))).toBe(false)
  })

  it('compares functions and other objects by identity', () => {
    const run = (): void => undefined
    expect(sameData({ run }, { run })).toBe(true)
    expect(sameData({ run }, { run: (): void => undefined })).toBe(false)
    expect(sameData(new Date(0), new Date(0))).toBe(false)
  })
})

const noop = (): void => {}
const props = (canvas: ProjectCanvas, onSelect = noop): CanvasCardProps => ({
  canvas,
  view: { state: 'idle', active: false, label: '', detail: '', outputs: [] },
  selected: false,
  dragging: false,
  tool: 'select',
  selectedRegionId: null,
  rerun: { ok: true },
  hasOutput: false,
  onSelect,
  onPortDown: noop,
  onSelectRegion: noop,
  onChangeLayers: noop,
  onRegionDrawn: noop,
  onEditRegion: noop,
  onEditDone: noop,
  onDragStart: noop,
  onOpenViewer: noop,
  onRerun: noop,
  onCancel: noop,
  onShowActivity: noop,
})

describe('canvas face preview', () => {
  const output = { path: '/old.png', width: 1024, height: 1024, seed: 4 }
  const strip = {
    items: [
      { number: 1, runId: 'old', output: 0, path: output.path },
      { number: 2, runId: 'new', output: 0 },
    ],
    shown: 1,
    queued: [],
    views: new Map(),
    onShow: noop,
    onOpen: noop,
    onCancelQueued: noop,
    onPointerDown: noop,
  }
  const base = props(canvasFixture({ backgroundPath: '/back.png' }))
  const initPicture = { path: '/init.png', size: null }
  function renderCard(first: CanvasCardProps) {
    const host = document.createElement('div')
    root = createRoot(host)
    const render = (p: CanvasCardProps) =>
      act(() => root!.render(createElement(Fragment, null, createElement(CanvasCard, p), createElement(ImageLightbox))))
    render(first)
    return { host, render, zoom: () => host.querySelector<HTMLButtonElement>('button[aria-label^="放大预览"]') }
  }

  it.each<[string, Partial<CanvasCardProps>, string]>([
    ['background', {}, 'back'],
    ['linked start image over background', { initPicture }, 'init'],
    ['imported image', { canvas: canvasFixture({ kind: 'image', imagePath: '/import.png' }) }, 'import'],
    [
      'picked output over start image',
      {
        initPicture,
        view: { ...base.view, outputs: [output, { ...output, path: '/pick.png' }] },
        strip: { ...strip, items: [{ runId: 'old', output: 1, number: 1, path: '/pick.png' }], shown: 0 },
      },
      'pick',
    ],
  ])('opens the displayed %s', (_label, patch, expected) => {
    const { host, zoom } = renderCard({ ...base, ...patch })
    const src = host.querySelector<HTMLImageElement>('[data-card-body] img')!.src
    expect(src).toBe(`clover://local?path=%2F${expected}.png`)
    expect(zoom()).not.toBeNull()
    act(() => zoom()!.click())
    expect(document.querySelector<HTMLImageElement>('dialog img')?.src).toBe(src)
  })

  it('opens the visible live frame instead of an old output or the next frame still loading', () => {
    const view = { ...base.view, active: true, state: 'running' as const, outputs: [output], preview: { path: '/live.png', seq: 1 } }
    const { host, render, zoom } = renderCard({ ...base, view, strip })
    act(() => {
      host.querySelector('[data-live-preview] img')!.dispatchEvent(new Event('load'))
    })
    render({ ...base, view: { ...view, preview: { ...view.preview, seq: 2 } }, strip })
    const front = host.querySelector<HTMLImageElement>('[data-preview-front]')!.src
    expect(front).toBe('clover://local?path=%2Flive.png&seq=1')
    act(() => zoom()!.click())
    expect(document.querySelector<HTMLImageElement>('dialog img')?.src).toBe(front)
    expect(document.querySelector('dialog')?.textContent).not.toContain('另存为')
  })

  it('keeps the zoom button in the header, off the picture corner and inside the card stacking order', () => {
    const { zoom } = renderCard(base)
    expect(zoom()!.closest('header')).not.toBeNull()
    expect(zoom()!.className).not.toMatch(/(^|\s)(z-|absolute)/)
  })

  it('offers no zoom on an empty running face even when the strip has older pictures', () => {
    const { host, zoom } = renderCard({ ...base, canvas: canvasFixture(), view: { ...base.view, active: true, state: 'running' }, strip })
    expect(host.querySelector('[data-card-body] img')).toBeNull()
    expect(zoom()).toBeNull()
  })
})

describe('studio/CanvasCard memo', () => {
  it('skips a render when only fresh copies of the same data arrive', () => {
    const onSelect = vi.fn()
    expect(sameCardProps(props(canvasFixture({ x: 10 }), onSelect), props(canvasFixture({ x: 10 }), onSelect))).toBe(true)
  })

  it('renders when the data or a callback changes', () => {
    const onSelect = vi.fn()
    expect(sameCardProps(props(canvasFixture({ x: 10 }), onSelect), props(canvasFixture({ x: 11 }), onSelect))).toBe(false)
    expect(sameCardProps(props(canvasFixture(), onSelect), props(canvasFixture(), vi.fn()))).toBe(false)
  })
})

describe('studio/useStableCallbacks', () => {
  it('keeps the same function across renders and calls the latest closure', () => {
    const seen: string[] = []
    const hook = mount<string>((label) => useStableCallbacks().bind('card-1', { select: () => seen.push(label) }), 'first')
    const before = (hook.current() as { select: () => void }).select
    hook.rerender('second')
    const after = (hook.current() as { select: () => void }).select
    expect(after).toBe(before)
    before()
    expect(seen).toEqual(['second'])
  })

  it('keeps callbacks of different keys apart', () => {
    const seen: string[] = []
    const hook = mount(() => {
      const { bind } = useStableCallbacks()
      return [bind('a', { run: () => seen.push('a') }), bind('b', { run: () => seen.push('b') })]
    }, null)
    const [a, b] = hook.current() as { run: () => void }[]
    expect(a!.run).not.toBe(b!.run)
    b!.run()
    expect(seen).toEqual(['b'])
  })

  it('forgets keys that are not retained, closures included', () => {
    const seen: string[] = []
    const hook = mount(() => useStableCallbacks(), null)
    const callbacks = hook.current() as ReturnType<typeof useStableCallbacks>
    const gone = callbacks.bind('gone', { run: () => seen.push('gone') })
    const kept = callbacks.bind('kept', { run: () => seen.push('kept') })
    callbacks.retain(['kept'])
    gone.run()
    kept.run()
    expect(seen).toEqual(['kept'])
    expect(callbacks.bind('gone', { run: () => seen.push('again') }).run).not.toBe(gone.run)
  })
})

describe('studio/useCardDrag', () => {
  function pointer(type: string, x: number, buttons = 1): PointerEvent {
    return new PointerEvent(type, { pointerId: 7, clientX: x, clientY: 0, buttons, bubbles: true })
  }

  function press(drag: ReturnType<typeof useCardDrag>): void {
    const element = document.createElement('header')
    element.setPointerCapture = vi.fn()
    element.hasPointerCapture = () => false
    const event = { pointerId: 7, clientX: 0, clientY: 0, currentTarget: element, stopPropagation: vi.fn() }
    act(() => drag.start(canvasFixture({ id: 'card', x: 100, y: 50 }), event as unknown as React.PointerEvent<HTMLElement>))
  }

  it('draws each step and writes the place once, when the card is let go', () => {
    const onMove = vi.fn()
    const onDrop = vi.fn()
    const hook = mount(() => useCardDrag({ zoom: { current: 2 }, onMove: { current: onMove }, onDrop: { current: onDrop } }), null)
    press(hook.current() as ReturnType<typeof useCardDrag>)
    act(() => {
      window.dispatchEvent(pointer('pointermove', 20))
      window.dispatchEvent(pointer('pointermove', 40))
    })
    expect(onMove.mock.calls).toEqual([
      ['card', 110, 50],
      ['card', 120, 50],
    ])
    expect(onDrop).not.toHaveBeenCalled()
    act(() => {
      window.dispatchEvent(pointer('pointerup', 40, 0))
    })
    expect(onDrop.mock.calls).toEqual([['card', 120, 50]])
  })

  it('ends the drag where the card is when the window loses focus', () => {
    const onDrop = vi.fn()
    const hook = mount(() => useCardDrag({ zoom: { current: 1 }, onMove: { current: vi.fn() }, onDrop: { current: onDrop } }), null)
    press(hook.current() as ReturnType<typeof useCardDrag>)
    act(() => {
      window.dispatchEvent(pointer('pointermove', 30))
      window.dispatchEvent(new Event('blur'))
    })
    expect(onDrop.mock.calls).toEqual([['card', 130, 50]])
    act(() => {
      window.dispatchEvent(pointer('pointerup', 30, 0))
    })
    expect(onDrop).toHaveBeenCalledTimes(1)
  })

  it('writes nothing for a press that does not move', () => {
    const onMove = vi.fn()
    const onDrop = vi.fn()
    const hook = mount(() => useCardDrag({ zoom: { current: 1 }, onMove: { current: onMove }, onDrop: { current: onDrop } }), null)
    press(hook.current() as ReturnType<typeof useCardDrag>)
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1, 0))
    })
    expect(onMove).not.toHaveBeenCalled()
    expect(onDrop).not.toHaveBeenCalled()
  })
})
