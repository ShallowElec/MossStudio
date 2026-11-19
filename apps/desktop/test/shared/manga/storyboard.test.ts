import { describe, expect, it } from 'vitest'
import { LAYOUT_STYLE_LABEL } from '@shared/manga/gacha'
import { PAGE_TEMPLATES, framesFit, leafCount, templateById, type FrameNode } from '@shared/manga/layouts'
import { mangaPageSchema } from '@shared/manga/model'
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
    expect(request.system).toContain('action（动作）')
    expect(request.system).toContain('"style": "分格风格"')
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
    expect(pages[0]!.frames).toEqual(templateById('two-rows')!.frames)
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
    expect(pages.map((page) => [page.frames, page.panels.length])).toEqual([
      [templateById('two-rows')!.frames, 2],
      [templateById('six-grid')!.frames, 6],
      [templateById('two-rows')!.frames, 2],
    ])
    const first = pages[0]!.panels[0]!
    expect(first.shot).toBe('medium')
    expect(first.cast).toEqual([])
    expect(first.dialogue[0]).toMatchObject({ kind: 'speech', speakerId: 'char-aki' })
    expect(pages[0]!.panels[1]!.cast[0]).not.toHaveProperty('outfitId')
  })

  it('draws each page in the style it asks for, with as many panels as it has, slanted and bleeding for action', () => {
    const page = (style: string, count: number) => ({
      style,
      panels: Array.from({ length: count }, (_, at) => ({ scene: `第 ${at + 1} 格`, shot: 'medium' })),
    })
    const slanted = (node: FrameNode): boolean =>
      node.kind === 'split' && (Boolean(node.slant) || slanted(node.first) || slanted(node.second))
    const bleeding = (node: FrameNode): boolean =>
      node.kind === 'panel' ? Boolean(node.bleed) : bleeding(node.first) || bleeding(node.second)
    const isTemplate = (frames: FrameNode) => PAGE_TEMPLATES.some((template) => JSON.stringify(template.frames) === JSON.stringify(frames))

    const actionPages = Array.from({ length: 6 }, () => page('action', 4))
    const { pages, warnings } = parseStoryboard(
      JSON.stringify({ pages: [...actionPages, page('dialogue', 5), page(' splash ', 2)] }),
      series,
      counter(),
    )
    expect(warnings).toEqual([])
    for (const drawn of pages) {
      expect(framesFit(drawn.frames)).toBe(true)
      expect(isTemplate(drawn.frames)).toBe(false)
      expect(leafCount(drawn.frames)).toBe(drawn.panels.length)
    }
    expect(pages.map((item) => item.panels.length)).toEqual([4, 4, 4, 4, 4, 4, 5, 2])
    const action = pages.slice(0, 6).map((item) => item.frames)
    expect(action.some(slanted)).toBe(true)
    expect(action.some(bleeding)).toBe(true)
    // Dialogue pages are drawn straight and inside the margins.
    expect(slanted(pages[6]!.frames) || bleeding(pages[6]!.frames)).toBe(false)
    // The same answer and ids give the same pages.
    expect(parseStoryboard(JSON.stringify({ pages: actionPages }), series, counter()).pages[0]!.frames).toEqual(pages[0]!.frames)
  })

  it('keeps a fixed layout when the style is one it does not know, and draws six panels in every style', () => {
    const many = Array.from({ length: 6 }, (_, at) => ({ scene: `第 ${at + 1} 格`, shot: 'wide' }))
    const unknown = parseStoryboard(
      JSON.stringify({ pages: [{ style: 'fancy', layout: 'two-rows', panels: many.slice(0, 2) }] }),
      series,
      counter(),
    )
    expect(unknown.warnings).toEqual([])
    expect(unknown.pages[0]!.frames).toEqual(templateById('two-rows')!.frames)

    for (const style of Object.keys(LAYOUT_STYLE_LABEL)) {
      const { pages, warnings } = parseStoryboard(JSON.stringify({ pages: [{ style, panels: many }] }), series, counter())
      expect(warnings, style).toEqual([])
      expect(leafCount(pages[0]!.frames), style).toBe(6)
      expect(framesFit(pages[0]!.frames), style).toBe(true)
    }
  })

  it('fails with a plain message when the answer is not a storyboard', () => {
    expect(() => parseStoryboard('我不太明白', series, counter())).toThrow('语言模型没有返回可读的结果，请再试一次')
    expect(() => parseStoryboard('{"pages": []}', series, counter())).toThrow('语言模型返回的分镜格式不对，请再试一次')
    expect(() => parseStoryboard('{"pages": [}', series, counter())).toThrow('语言模型返回的结果格式不对，请再试一次')
  })

  it('keeps every field within what the document can save', () => {
    const long = (n: number) => '长'.repeat(n)
    const answer = JSON.stringify({
      pages: [
        {
          layout: 'single',
          panels: [
            {
              scene: '港口',
              shot: 'wide',
              cast: [{ name: '阿秋', expression: long(300), pose: long(250) }],
              dialogue: Array.from({ length: 15 }, (_, i) => ({
                speaker: '阿秋',
                kind: 'speech',
                text: i === 0 ? long(1200) : `第 ${i} 句`,
              })),
            },
          ],
        },
      ],
    })
    const { pages, warnings } = parseStoryboard(answer, series, counter())
    const panel = pages[0]!.panels[0]!
    expect(panel.cast[0]!.expression).toHaveLength(200)
    expect(panel.cast[0]!.pose).toHaveLength(200)
    expect(panel.dialogue).toHaveLength(12)
    expect(panel.dialogue[0]!.text).toHaveLength(1000)
    expect(warnings).toEqual(expect.arrayContaining(['有的描述或台词太长，已截断', '一格最多 12 句对白，多出的已去掉']))
    expect(mangaPageSchema.safeParse(pages[0]).success).toBe(true)
  })
})
