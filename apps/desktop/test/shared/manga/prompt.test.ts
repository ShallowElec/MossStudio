import { describe, expect, it } from 'vitest'
import { compilePanelPrompt } from '@shared/manga/prompt'
import { mangaSeriesFixture } from '../../mocks/backend/manga'

const series = mangaSeriesFixture()
const [first, second, third] = series.chapters[0]!.pages[0]!.panels

describe('compilePanelPrompt', () => {
  it('puts the style, shot, scene and each character with the outfit they wear in the description', () => {
    const compiled = compilePanelPrompt(series, first!)
    expect(compiled.problems).toEqual([])
    expect(compiled.prompt.split('\n')).toEqual([
      '黑白漫画，网点，粗线条',
      '远景，人物很小，交代环境',
      '雨夜的街道，霓虹灯倒映在积水里',
      '阿秋：akiOC，短黑发，琥珀色眼睛，左眉有小疤，深蓝色水手服，红色领结，皱眉，撑伞',
    ])
  })

  it('uses the outfit chosen for this panel over the default one', () => {
    const coat = { ...first!, cast: [{ characterId: 'char-aki', outfitId: 'outfit-coat', expression: '', pose: '' }] }
    expect(compilePanelPrompt(series, coat).prompt).toContain('卡其色长风衣')
    expect(compilePanelPrompt(series, coat).prompt).not.toContain('水手服')
  })

  it('adds the style LoRA and each character LoRA once, and the first reference picture of each character', () => {
    const both = { ...first!, cast: [...first!.cast, ...second!.cast, { characterId: 'char-aki', expression: '', pose: '' }] }
    const compiled = compilePanelPrompt(series, both)
    expect(compiled.adapters).toEqual([
      { id: 'ink-style', strength: 1 },
      { id: 'aki-lora', strength: 0.8 },
    ])
    // 莲 has no reference picture; 阿秋 is listed twice but sends one.
    expect(compiled.references).toEqual([
      '/fixture/projects/project-manga/assets/aki.png',
      '/fixture/projects/project-manga/assets/aki.png',
    ])
  })

  it('keeps lettering out of the picture and adds the reviewer note', () => {
    const compiled = compilePanelPrompt(series, { ...third!, note: '眼神更凶一点' })
    expect(compiled.negative).toBe('彩色，文字，对白框，水印')
    expect(compiled.prompt).toContain('修改要求：眼神更凶一点')
  })

  it('reports an empty scene and a deleted character, and lets an override replace the description', () => {
    const broken = { ...first!, scene: ' ', cast: [{ characterId: 'gone', expression: '', pose: '' }] }
    expect(compilePanelPrompt(series, broken).problems).toEqual(['这一格用了一个已经删除的人物，请重新选择', '这一格还没有画面描述'])
    const override = compilePanelPrompt(series, { ...broken, cast: [], promptOverride: '自己写的描述' })
    expect(override).toMatchObject({ prompt: '自己写的描述', problems: [] })
  })
})
