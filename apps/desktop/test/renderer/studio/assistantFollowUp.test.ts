import { describe, expect, it } from 'vitest'
import type { AgentCard } from '@shared/agent/cards'
import { followUpFor } from '@renderer/pages/studio/assistant/Assistant'

const card = (kind: AgentCard['kind']): AgentCard => ({ id: 'card-1', kind, title: '换风格', createdAt: '2026-11-24T10:00:00.000Z' })

describe('studio/assistant followUpFor', () => {
  it('tells the model a declined plan is not applied, instead of carrying on with defaults', () => {
    expect(followUpFor(card('plan'), { selected: [], skipped: true }, [])).toBe('方案先不应用。')
  })

  it('keeps the typed adjustment for a plan', () => {
    expect(followUpFor(card('plan'), { selected: [], freeText: '少改一处' }, [])).toBe('方案先不应用，改一下：少改一处')
  })

  it('still skips a choice card with defaults', () => {
    expect(followUpFor(card('choice'), { selected: [], skipped: true }, [])).toBe('「换风格」先跳过，你按默认继续。')
  })
})
