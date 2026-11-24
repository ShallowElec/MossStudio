import { describe, expect, it } from 'vitest'
import { modelGroups } from '@renderer/pages/studio/assistant/ModelPicker'

describe('collab model picker grouping', () => {
  it('heads each provider once, keeps models without one ahead of them, and drops a repeated provider from the label', () => {
    const groups = modelGroups([
      { id: 'solo', label: 'solo' },
      { id: 'kimi-k3', label: 'Kimi K3', provider: 'kimi-coding' },
      { id: 'kimi-for-coding', label: 'kimi-for-coding · kimi-coding', provider: 'kimi-coding' },
      { id: 'opus', label: 'opus · workbench-claude-cli', provider: 'workbench-claude-cli' },
    ])
    expect(groups.map((group) => group.provider)).toEqual([undefined, 'kimi-coding', 'workbench-claude-cli'])
    expect(groups[0]!.choices.map((choice) => choice.label)).toEqual(['solo'])
    expect(groups[1]!.choices.map((choice) => choice.label)).toEqual(['Kimi K3', 'kimi-for-coding'])
    expect(groups[2]!.choices.map((choice) => choice.label)).toEqual(['opus'])
  })

  it('keeps one id offered by two providers distinguishable, and each choice carries its own provider', () => {
    const groups = modelGroups([
      { id: 'shared', label: 'shared', provider: 'alpha' },
      { id: 'shared', label: 'shared', provider: 'beta' },
    ])
    const choices = groups.flatMap((group) => group.choices)
    expect(new Set(choices.map((choice) => choice.value)).size).toBe(2)
    expect(choices.map((choice) => [choice.model.id, choice.model.provider])).toEqual([
      ['shared', 'alpha'],
      ['shared', 'beta'],
    ])
  })

  it('still separates a repeated id inside one provider, and skips an entry with no id', () => {
    const groups = modelGroups([
      { id: 'dup', label: 'one', provider: 'alpha' },
      { id: 'dup', label: 'two', provider: 'alpha' },
      { id: '  ', label: 'blank' },
    ])
    const choices = groups.flatMap((group) => group.choices)
    expect(choices.map((choice) => choice.label)).toEqual(['one', 'two'])
    expect(new Set(choices.map((choice) => choice.value)).size).toBe(2)
  })

  it('gives every choice a printable value, distinct even when provider and id read the same', () => {
    const choices = modelGroups([
      { id: 'x/y', label: 'plain' },
      { id: 'y', label: 'nested', provider: 'x' },
      { id: 'y', label: 'again', provider: 'x' },
    ]).flatMap((group) => group.choices)
    expect(new Set(choices.map((choice) => choice.value)).size).toBe(3)
    // Printable ASCII only: a NUL or other control character made the DOM unreadable in devtools.
    for (const choice of choices) expect(choice.value).toMatch(/^[ -~]+$/)
  })

  it('offers nothing for an Agent that lists no models', () => {
    expect(modelGroups([])).toEqual([])
  })
})
