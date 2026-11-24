import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SamplingSection } from '@renderer/pages/studio/SamplingSection'
import { engineFeaturesFixture } from '@test/mocks/backend'
import { canvas } from './fixtures'

it('hides non-Worker controls while probing and clears only those saved choices on request', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const card = canvas({
    sampling: { sampler: 'euler', scheduler: 'moss', shift: 4, cfgTruncation: 0, stepCache: 'off', hires: { width: 1536, height: 1536 } },
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  const onChange = vi.fn<(update: (current: typeof card) => typeof card) => void>()
  try {
    for (const features of [undefined, engineFeaturesFixture()]) {
      act(() => root.render(createElement(SamplingSection, { canvas: card, features, worker: true, onChange })))
      expect(host.querySelector('#studio-shift, #studio-cfg-truncation, #studio-step-cache, [data-hires]')).toBeNull()
      expect(host.querySelector('#studio-sampler')).not.toBeNull()
      expect(host.querySelector('#studio-scheduler')).not.toBeNull()
      expect(onChange).not.toHaveBeenCalled()
    }
    const clear = [...host.querySelectorAll('button')].find((button) => button.textContent === '清除不支持的采样设置')
    expect(clear).toBeDefined()
    act(() => clear!.click())
    expect(onChange.mock.calls[0]![0](card).sampling).toEqual({ sampler: 'euler', scheduler: 'moss' })
  } finally {
    act(() => root.unmount())
  }
})

it('lets a Worker canvas reset saved enum choices to default when its capabilities are unavailable', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let card = canvas({ sampling: { sampler: 'old-sampler', scheduler: 'old-scheduler' } })
  const host = document.createElement('div')
  const root = createRoot(host)
  const onChange = (update: (current: typeof card) => typeof card): void => {
    card = update(card)
  }
  try {
    act(() => root.render(createElement(SamplingSection, { canvas: card, features: null, worker: true, onChange })))
    for (const key of ['sampler', 'scheduler']) {
      const select = host.querySelector<HTMLSelectElement>(`#studio-${key}`)!
      expect(select.disabled).toBe(false)
      expect([...select.options].filter((option) => !option.disabled).map((option) => option.value)).toEqual([''])
      act(() => {
        select.value = ''
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    expect(card).not.toHaveProperty('sampling')
  } finally {
    act(() => root.unmount())
  }
})

it('shows a 高清修复 target saved over the pixel budget at the fitted size the job uses', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const card = canvas({ width: 1024, height: 1024, sampling: { hires: { width: 4096, height: 4096 } } })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() =>
      root.render(createElement(SamplingSection, { canvas: card, features: engineFeaturesFixture(), worker: false, onChange: vi.fn() })),
    )
    expect(host.textContent).toContain('输出 2048 × 2048')
    expect(host.textContent).not.toContain('4096')
  } finally {
    act(() => root.unmount())
  }
})
