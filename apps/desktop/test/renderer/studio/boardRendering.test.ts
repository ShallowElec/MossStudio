import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProjectCanvas } from '@shared/types'
import { canvasFixture } from '@test/mocks/backend'
import { sameCardProps, type CanvasCardProps } from '@renderer/pages/studio/CanvasCard'
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

describe('studio/CanvasCard memo', () => {
  const props = (canvas: ProjectCanvas, onSelect: () => void): CanvasCardProps =>
    ({
      canvas,
      view: { state: 'idle', active: false, label: '', detail: '', outputs: [] },
      selected: false,
      dragging: false,
      tool: 'select',
      selectedRegionId: null,
      rerun: { ok: true },
      hasOutput: false,
      onSelect,
    }) as unknown as CanvasCardProps

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
