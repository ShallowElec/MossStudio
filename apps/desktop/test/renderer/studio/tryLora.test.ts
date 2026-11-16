import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@renderer/pages/studio/canvases'
import { generationCanvas, tryLoraOnBoard } from '@renderer/pages/studio/nodes'
import { isStudioTryRequest } from '@renderer/lib/studioTry'
import { canvas } from './fixtures'

const lora = { name: '橘子', adapterId: 'lora-tp-juzi', prompt: 'juzi，坐在窗边，柔和的自然光' }

describe('在创作中试用 (tryLoraOnBoard)', () => {
  it('adds a 风格 named after the training that holds its LoRA at strength 1', () => {
    const made = tryLoraOnBoard([], defaultSettings(), lora)
    expect(made.style.kind).toBe('style')
    expect(made.style.title).toBe('橘子')
    expect(made.style.adapters).toEqual([{ id: 'lora-tp-juzi', strength: 1 }])
  })

  it('adds a new 画面 wired to the 风格 whose description is the sample prompt', () => {
    const existing = [canvas({ id: 'c1', title: '画面 1' })]
    const made = tryLoraOnBoard(existing, defaultSettings(), lora)
    expect(made.canvases.map((item) => item.id)).toEqual(['c1', made.style.id, made.layout.id])
    expect(made.layout.kind).toBe('layout')
    expect(made.layout.prompt).toBe(lora.prompt)
    expect(made.layout.summary.caption).toBe(lora.prompt)
    expect(made.layout.inputs?.styles?.links).toEqual([{ canvasId: made.style.id }])
    expect(made.layout.title).not.toBe('画面 1')
  })

  it('generates with the trained LoRA alone, not LoRA carried over from earlier settings', () => {
    const settings = { ...defaultSettings(), adapters: [{ id: 'other-lora', strength: 0.5 }] }
    const made = tryLoraOnBoard([], settings, lora)
    expect(made.layout.adapters).toEqual([])
    expect(generationCanvas(made.layout, made.canvases).adapters).toEqual([{ id: 'lora-tp-juzi', strength: 1 }])
  })

  it('places the 画面 beside the 风格 without covering it', () => {
    const made = tryLoraOnBoard([], defaultSettings(), lora)
    expect(made.layout.x).toBeGreaterThan(made.style.x)
  })

  it('accepts only well-formed requests', () => {
    expect(isStudioTryRequest({ id: 'r1', ...lora })).toBe(true)
    expect(isStudioTryRequest({ id: 'r1', ...lora, adapterId: '' })).toBe(false)
    expect(isStudioTryRequest({ ...lora })).toBe(false)
    expect(isStudioTryRequest(null)).toBe(false)
  })
})
