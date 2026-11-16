import { describe, expect, it } from 'vitest'
import { presetRecipe } from '@shared/training'
import {
  advancedSummary,
  filterPictures,
  lengthLabel,
  problemBadge,
  problemChips,
  withImage,
  withKind,
  withLength,
  withRecipe,
  withTrigger,
} from '@renderer/pages/training/editorModel'
import { datasetFixture, datasetOf, trainingProjectFixture } from '../../mocks/backend/training'

const person = trainingProjectFixture()

describe('训练多久 and 高级 in words', () => {
  it('shows the step count, and 自定义 once a knob was changed', () => {
    expect(lengthLabel(person)).toBe('3,000 步')
    expect(lengthLabel({ ...person, length: 'custom', recipe: { ...person.recipe, steps: 3500 } })).toBe('自定义 · 3,500 步')
  })

  it('sums up 高级 in one line', () => {
    expect(advancedSummary(person, '本机')).toBe('LoKr · 3,000 步 · 本机')
    expect(advancedSummary({ recipe: presetRecipe('style', 'fast', { samples: false, trigger: '' }) }, '工作室主机')).toBe(
      'LoRA · 750 步 · 工作室主机',
    )
  })
})

describe('editing a draft', () => {
  it('学什么 sets that kind’s recipe at the same length and touches nothing else', () => {
    const patch = withKind(
      { ...person, length: 'fine', recipe: presetRecipe('person', 'fine', { samples: true, trigger: 'juzi' }) },
      'object',
    )
    expect(Object.keys(patch).sort()).toEqual(['kind', 'length', 'recipe', 'trigger'])
    expect(patch.kind).toBe('object')
    expect(patch.length).toBe('fine')
    expect(patch.recipe).toMatchObject({ algo: 'lora', dim: 16, steps: 3000 })
    expect(patch.recipe!.samplePrompts[0]).toContain('juzi')
  })

  it('画风 needs no trigger word; back to 人物 a trigger comes from the name', () => {
    const style = withKind(person, 'style')
    expect(style.trigger).toBe('')
    const back = withKind({ ...person, ...style, name: 'Mimi' } as typeof person, 'person')
    expect(back.trigger).toBe('mimi')
  })

  it('a custom recipe starts again from 标准 when 学什么 changes', () => {
    expect(withKind({ ...person, length: 'custom' }, 'style').length).toBe('standard')
  })

  it('training length keeps the sample settings the person chose', () => {
    const custom = { ...person, recipe: { ...person.recipe, sampleEvery: 500, samplePrompts: ['juzi 在月亮上'] } }
    const patch = withLength(custom, 'fast')
    expect(patch.length).toBe('fast')
    expect(patch.recipe).toMatchObject({ steps: 1500, sampleEvery: 500, samplePrompts: ['juzi 在月亮上'] })
  })

  it('a knob under 高级 makes the length 自定义, and putting it back finds the preset again', () => {
    const changed = withRecipe(person, { steps: 3500 })
    expect(changed.length).toBe('custom')
    expect(withRecipe({ ...person, ...changed } as typeof person, { steps: 3000 }).length).toBe('standard')
  })

  it('a new trigger word replaces the old one in the sample descriptions', () => {
    const patch = withTrigger(person, 'orange')
    expect(patch.trigger).toBe('orange')
    expect(patch.recipe!.samplePrompts.every((prompt) => prompt.includes('orange') && !prompt.includes('juzi'))).toBe(true)
  })

  it('leaves sample descriptions the person wrote alone, even where the old trigger is part of a word', () => {
    const custom = { ...person, trigger: 'a', recipe: { ...person.recipe, samplePrompts: ['a cat and a hat', 'a 在雪地里'] } }
    const patch = withTrigger(custom, 'al')
    expect(patch).toEqual({ trigger: 'al' })
  })

  it('follows the trigger through an empty field while the descriptions are still the defaults', () => {
    const cleared = { ...person, ...withTrigger(person, '') } as typeof person
    const retyped = withTrigger(cleared, 'mimi')
    expect(retyped.recipe!.samplePrompts).toEqual(presetRecipe('person', 'standard', { samples: true, trigger: 'mimi' }).samplePrompts)
  })
})

describe('picture problems', () => {
  const dataset = datasetOf(datasetFixture('tp-juzi'))

  it('offers a chip for each kind of problem there is', () => {
    expect(problemChips(dataset).map((chip) => chip.label)).toEqual(['2 张太小', '1 张重复', '6 张没有描述'])
    expect(problemChips(datasetOf([]))).toEqual([])
  })

  it('filters the pictures by a chip', () => {
    expect(filterPictures(dataset.images, 'small')).toHaveLength(2)
    expect(filterPictures(dataset.images, 'duplicate')).toHaveLength(1)
    expect(filterPictures(dataset.images, 'noCaption')).toHaveLength(6)
    expect(filterPictures(dataset.images, 'all')).toHaveLength(24)
  })

  it('badges a picture with its problem', () => {
    expect(problemBadge(dataset.images[7]!)).toBe('太小 · 384 × 288')
    expect(problemBadge(dataset.images[11]!)).toBe('和第 4 张重复')
    expect(problemBadge(dataset.images[0]!)).toBeNull()
  })

  it('keeps the 没有描述 count true after a description is written', () => {
    const image = { ...dataset.images[4]!, caption: 'juzi 在纸箱里' }
    expect(withImage(dataset, image).counts.noCaption).toBe(5)
  })
})
