import { describe, expect, it } from 'vitest'
import { parseStoryboard, storyboardRequest } from '@shared/manga/storyboard'
import { mangaSeriesFixture } from '../../mocks/backend/manga'

function counter(): (prefix: string) => string {
  let next = 0
  return (prefix) => `${prefix}-${++next}`
}

const series = mangaSeriesFixture()

describe('storyboardRequest', () => {
  it('gives the model the characters, outfits, memory and outline, and the only shapes it may answer with', () => {
    const chapter = { ...series.chapters[0]!, id: 'chapter-2', number: 2, title: '', outline: '旧港口的对决' }
    const withPrevious = { ...series, chapters: [{ ...series.chapters[0]!, summary: '阿秋接下委托。' }, chapter] }
    const request = storyboardRequest(withPrevious, chapter, { pages: 6 })
    expect(request.system).toContain('只输出一个 JSON 对象')
    expect(request.system).toContain('grid-four（4 格，田字四格）')
    expect(request.system).toContain('从右到左')
    expect(request.user).toContain('- 阿秋（主角）')
    expect(request.user).toContain('服装：校服、风衣')
    expect(request.user).toContain('第 1 话「雨中的委托」：阿秋接下委托。')
    expect(request.user).toContain('阿秋左眉的疤是十岁时留下的')
    expect(request.user).toContain('第 2 话，大约 6 页。大纲：\n旧港口的对决')
  })
})

describe('parseStoryboard', () => {
  it('maps names to characters and outfits, and places the balloons from the reading side', () => {
    const answer = `好的，分镜如下：
\`\`\`json
{"pages": [{"layout": "two-rows", "panels": [
  {"scene": "港口全景", "shot": "wide", "cast": [{"name": "阿秋", "outfit": "风衣", "expression": "警惕"}],
   "dialogue": [{"kind": "narration", "text": "午夜的港口。"}, {"speaker": "阿秋", "kind": "speech", "text": "就是这里。"}]},
  {"scene": "莲的侧脸", "shot": "close", "cast": [{"name": " 莲 "}], "dialogue": []}
]}]}
\`\`\``
    const { pages, warnings } = parseStoryboard(answer, series, counter())
    expect(warnings).toEqual([])
    expect(pages).toHaveLength(1)
    expect(pages[0]!.layoutId).toBe('two-rows')
    const [port, face] = pages[0]!.panels
    expect(port).toMatchObject({ scene: '港口全景', shot: 'wide', state: 'draft' })
    expect(port!.cast).toEqual([{ characterId: 'char-aki', outfitId: 'outfit-coat', expression: '警惕', pose: '' }])
    expect(port!.dialogue.map((line) => [line.kind, line.speakerId, line.text])).toEqual([
      ['narration', undefined, '午夜的港口。'],
      ['speech', 'char-aki', '就是这里。'],
    ])
    // Right to left: the first balloon is read first, so it sits further right.
    expect(port!.dialogue[0]!.x).toBeGreaterThan(port!.dialogue[1]!.x)
    expect(face!.cast[0]!.characterId).toBe('char-ren')
  })

  it('fixes what it can and says what it changed', () => {
    const answer = JSON.stringify({
      pages: [
        {
          layout: 'grid-four',
          panels: [
            {
              scene: '路人走过',
              shot: 'tracking',
              cast: [{ name: '路人甲' }],
              dialogue: [{ speaker: '阿秋', kind: 'yell', text: '站住！' }],
            },
            { scene: '', shot: 'close', cast: [{ name: '阿秋', outfit: '泳装' }], dialogue: [] },
          ],
        },
        { layout: 'nope', panels: Array.from({ length: 8 }, (_, index) => ({ scene: `格 ${index}`, shot: 'medium' })) },
      ],
    })
    const { pages, warnings } = parseStoryboard(answer, series, counter())
    expect(warnings).toEqual([
      '有的页格数和版式不一致，已换成合适的版式',
      '「路人甲」不在人物卡里，已从格子里去掉',
      '阿秋没有「泳装」这套服装，用了默认服装',
      '有的格子没有画面描述，请补上',
      '有一页的格子太多，已拆成两页',
    ])
    expect(pages.map((page) => [page.layoutId, page.panels.length])).toEqual([
      ['two-rows', 2],
      ['six-grid', 6],
      ['two-rows', 2],
    ])
    const first = pages[0]!.panels[0]!
    expect(first.shot).toBe('medium')
    expect(first.cast).toEqual([])
    expect(first.dialogue[0]).toMatchObject({ kind: 'speech', speakerId: 'char-aki' })
    expect(pages[0]!.panels[1]!.cast[0]).not.toHaveProperty('outfitId')
  })

  it('fails with a plain message when the answer is not a storyboard', () => {
    expect(() => parseStoryboard('我不太明白', series, counter())).toThrow('语言模型没有返回可读的结果，请再试一次')
    expect(() => parseStoryboard('{"pages": []}', series, counter())).toThrow('语言模型返回的分镜格式不对，请再试一次')
    expect(() => parseStoryboard('{"pages": [}', series, counter())).toThrow('语言模型返回的结果格式不对，请再试一次')
  })
})
