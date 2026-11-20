import { describe, expect, it } from 'vitest'
import { outsideWindow } from '@renderer/pages/studio/useRunDrag'

describe('dragging a filmstrip picture out of the window', () => {
  const size = { width: 1600, height: 1000 }

  it('stays the board’s own drag while the pointer is inside the window', () => {
    expect(outsideWindow({ clientX: 0, clientY: 0 }, size)).toBe(false)
    expect(outsideWindow({ clientX: 1599, clientY: 999 }, size)).toBe(false)
  })

  it('leaves the window past any edge', () => {
    expect(outsideWindow({ clientX: -1, clientY: 500 }, size)).toBe(true)
    expect(outsideWindow({ clientX: 800, clientY: -1 }, size)).toBe(true)
    expect(outsideWindow({ clientX: 1600, clientY: 500 }, size)).toBe(true)
    expect(outsideWindow({ clientX: 800, clientY: 1000 }, size)).toBe(true)
  })
})
