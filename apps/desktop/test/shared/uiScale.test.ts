import { describe, expect, it } from 'vitest'
import { uiZoomFactor } from '@shared/uiScale'

describe('shared/uiScale', () => {
  it('draws the default window at 100 % and grows with it when 自动', () => {
    expect(uiZoomFactor('auto', { width: 1600, height: 1000 })).toBe(1)
    // A maximized window on a 1440p screen: both sides grew by at least 40 %.
    expect(uiZoomFactor('auto', { width: 2560, height: 1400 })).toBe(1.4)
    // The shorter side decides: a wide but low window does not grow.
    expect(uiZoomFactor('auto', { width: 3000, height: 1000 })).toBe(1)
    // No more than 150 %.
    expect(uiZoomFactor('auto', { width: 3840, height: 2100 })).toBe(1.5)
  })

  it('never shrinks below 100 %, even in a small window', () => {
    expect(uiZoomFactor('auto', { width: 1100, height: 700 })).toBe(1)
    expect(uiZoomFactor('110', { width: 900, height: 600 })).toBe(1)
  })

  it('keeps a fixed size unless the page would fall below its minimum layout', () => {
    expect(uiZoomFactor('125', { width: 1600, height: 1000 })).toBe(1.25)
    expect(uiZoomFactor('150', { width: 1600, height: 1000 })).toBe(1.5)
    // 1280×800 at 150 % would leave a 853 px page; it stops at what fits (1280 / 1024 = 1.25).
    expect(uiZoomFactor('150', { width: 1280, height: 800 })).toBe(1.25)
  })

  it('moves in steps of 5 %, so resizing does not lay the page out at every pixel', () => {
    expect(uiZoomFactor('auto', { width: 1700, height: 1063 })).toBe(1.05)
    expect(uiZoomFactor('auto', { width: 1710, height: 1069 })).toBe(1.05)
  })
})
