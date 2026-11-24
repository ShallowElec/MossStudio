import { describe, expect, it } from 'vitest'
import {
  cleanSampling,
  clampHiresDimension,
  enumLabel,
  enumOptions,
  generationSize,
  hiresChoice,
  hiresScaleFits,
  hiresSize,
  outputSize,
  samplingSummary,
  scaleHires,
  withHiresPatch,
  withHiresScale,
  withSampling,
} from '@renderer/pages/studio/sampling'
import { resizeCanvas } from '@renderer/pages/studio/canvases'
import { MAX_PIXELS } from '@renderer/pages/studio/defaults'
import { engineFeaturesFixture } from '@test/mocks/backend'
import { canvas } from './fixtures'

describe('studio/sampling choices', () => {
  it('labels engine names with a friendly name plus the raw one, unknown ones verbatim', () => {
    expect(enumLabel('sampler', 'dpmpp_2m')).toBe('DPM++ 2M · dpmpp_2m')
    expect(enumLabel('scheduler', 'karras')).toBe('Karras · karras')
    expect(enumLabel('sampler', 'brand_new')).toBe('brand_new')
    expect(enumLabel('resize', 'fit')).toBe('适应')
  })

  it('offers 默认 first and only what the engine lists; a saved unknown value stays visible but disabled', () => {
    const features = engineFeaturesFixture({ values: { sampler: ['euler', 'heun'] } })
    expect(enumOptions(features, 'sampler').map((option) => option.value)).toEqual(['', 'euler', 'heun'])
    expect(enumOptions(features, 'sampler')[0]!.label).toBe('默认')
    expect(enumOptions(features, 'sampler', 'dpmpp_2m').at(-1)).toMatchObject({ value: 'dpmpp_2m', disabled: true })
    expect(enumOptions(null, 'scheduler')).toEqual([{ value: '', label: '默认' }])
  })

  it('keeps only fields that are set; nothing set is no sampling at all', () => {
    expect(cleanSampling({ sampler: '', shift: undefined })).toBeUndefined()
    expect(cleanSampling({ sampler: 'euler', cfgTruncation: 0 })).toEqual({ sampler: 'euler', cfgTruncation: 0 })
    const set = withSampling(canvas(), { sampler: 'heun' })
    expect(set.sampling).toEqual({ sampler: 'heun' })
    expect('sampling' in withSampling(set, { sampler: undefined })).toBe(false)
  })
})

describe('studio/sampling 高清修复', () => {
  it('scales the first-pass size onto the 16-pixel grid', () => {
    expect(hiresSize({ width: 1024, height: 1024 }, 1.5)).toEqual({ width: 1536, height: 1536 })
    expect(hiresSize({ width: 1152, height: 864 }, 1.5)).toEqual({ width: 1728, height: 1296 })
    // The engine refuses more than 4.2 million pixels, so a larger target is fitted inside, keeping its shape.
    expect(hiresSize({ width: 2048, height: 2048 }, 2)).toEqual({ width: 2048, height: 2048 })
    expect(hiresSize({ width: 3000, height: 3000 }, 2)).toEqual({ width: 2048, height: 2048 })
    expect(hiresSize({ width: 1920, height: 1088 }, 1.5)).toEqual({ width: 2720, height: 1536 })
    expect(clampHiresDimension(1500, 7)).toBe(1504)
    expect(clampHiresDimension(Number.NaN, 7)).toBe(7)
    // A result card takes this size and cards are at least 64 a side.
    expect(clampHiresDimension(16, 7)).toBe(64)
    expect(hiresSize({ width: 16, height: 16 }, 1.5)).toEqual({ width: 64, height: 64 })
  })

  it('turns on at a scale with a default strength, and reads the choice back', () => {
    const base = canvas({ width: 1280, height: 720 })
    const on = withHiresScale(base, 2)
    expect(on.sampling?.hires).toEqual({ width: 2560, height: 1440, strength: 0.35 })
    expect(hiresChoice(on)).toBe('2')
    expect(hiresChoice(withHiresScale(base, 1.5))).toBe('1.5')
    const custom = withHiresPatch(on, { width: 2000 })
    expect(hiresChoice(custom)).toBe('custom')
    expect(withHiresPatch(on, { steps: 12 }).sampling?.hires).toEqual({ width: 2560, height: 1440, strength: 0.35, steps: 12 })
    expect(withHiresPatch(withHiresPatch(on, { steps: 12 }), { steps: undefined }).sampling?.hires?.steps).toBeUndefined()
    expect(hiresChoice(base)).toBe('off')
  })

  it('keeps a hires target in proportion when the canvas is resized', () => {
    const sampling = { sampler: 'euler', hires: { width: 2048, height: 2048, strength: 0.4 } }
    expect(scaleHires(sampling, { width: 1024, height: 1024 }, { width: 1280, height: 720 })).toEqual({
      sampler: 'euler',
      hires: { width: 2560, height: 1440, strength: 0.4 },
    })
    expect(scaleHires(sampling, { width: 1024, height: 1024 }, { width: 1024, height: 1024 })).toBe(sampling)
    expect(scaleHires({ sampler: 'euler' }, { width: 1, height: 1 }, { width: 2, height: 2 })).toEqual({ sampler: 'euler' })
  })

  it('keeps every 高清修复 target within the engine pixel budget, and offers only the scales that fit', () => {
    // A 1024² 画面 at ×2, then a bigger pixel tier: the target would be 2912² (8.5 million pixels).
    const on = withHiresScale(canvas({ width: 1024, height: 1024 }), 2)
    const bigger = resizeCanvas(on, 1456, 1456)
    expect(bigger.sampling?.hires).toMatchObject({ width: 2048, height: 2048 })
    // ×2 no longer fits that 画面, so it is not shown as ×2; ×1.5 (2176², 4.7 million) does not fit either.
    expect(hiresScaleFits(bigger, 2)).toBe(false)
    expect(hiresScaleFits(bigger, 1.5)).toBe(false)
    expect(hiresChoice(bigger)).toBe('custom')
    expect(hiresScaleFits(canvas({ width: 1024, height: 1024 }), 2)).toBe(true)
    // Typed sizes, from the panel or the assistant, are fitted too.
    const typed = withHiresPatch(on, { width: 4096, height: 4096 }).sampling?.hires
    expect(typed!.width * typed!.height).toBeLessThanOrEqual(MAX_PIXELS)
    expect(withSampling(on, { hires: { width: 4096, height: 2048 } }).sampling?.hires).toMatchObject({ width: 2880, height: 1456 })
  })

  it('shows and edits a 高清修复 target saved over the pixel budget as the fitted size the job uses', () => {
    // Valid on disk before the budget: a 2048² 画面 at ×2.
    const saved = canvas({ width: 2048, height: 2048, sampling: { hires: { width: 4096, height: 4096, strength: 0.4 } } })
    expect(outputSize(saved)).toEqual({ width: 2048, height: 2048 })
    expect(hiresChoice(saved)).toBe('custom')
    expect(samplingSummary(saved)).toBe('高清修复 2048×2048')
    expect(withHiresPatch(saved, { steps: 8 }).sampling?.hires).toEqual({ width: 2048, height: 2048, strength: 0.4, steps: 8 })
    // Typing one edge keeps the other as shown, not as saved.
    expect(withHiresPatch(saved, { width: 1024 }).sampling?.hires).toMatchObject({ width: 1024, height: 2048 })
    // Fitted, it can match a scale that fits the 画面.
    expect(hiresChoice({ ...saved, width: 1024, height: 1024 })).toBe('2')
  })

  it('knows the first-pass and output sizes, including a recorded base size', () => {
    const on = withHiresScale(canvas({ width: 1024, height: 1024 }), 2)
    expect(generationSize(on)).toEqual({ width: 1024, height: 1024 })
    expect(outputSize(on)).toEqual({ width: 2048, height: 2048 })
    const result = { ...on, width: 2048, height: 2048, baseSize: { width: 1024, height: 1024 } }
    expect(generationSize(result)).toEqual({ width: 1024, height: 1024 })
    expect(outputSize(canvas())).toEqual({ width: 1024, height: 1024 })
  })

  it('summarises the choices for the collapsed 高级 line', () => {
    expect(samplingSummary(canvas())).toBe('')
    expect(samplingSummary(withHiresScale(withSampling(canvas(), { sampler: 'dpmpp_2m' }), 2))).toBe('DPM++ 2M · 高清修复 ×2')
    expect(samplingSummary(withHiresPatch(canvas(), { width: 2000, height: 1504 }))).toBe('高清修复 2000×1504')
  })
})
