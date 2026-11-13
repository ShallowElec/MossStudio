import { describe, expect, it } from 'vitest'
import { extractJson, memoryRequest, mergeFacts, parseMemory, storyMemory } from '@shared/manga/memory'
import type { MangaChapter } from '@shared/manga/model'
import { mangaSeriesFixture } from '../../mocks/backend/manga'

const chapter = (number: number, summary: string): MangaChapter => ({
  id: `chapter-${number}`,
  number,
  title: '',
  outline: '',
  summary,
  pages: [],
})

describe('storyMemory', () => {
  const series = mangaSeriesFixture({
    chapters: [chapter(2, '第二话的事。'), chapter(1, '第一话的事。'), chapter(3, ''), chapter(4, '之后的事。')],
  })

  it('lists the summaries of earlier chapters in order, then every fact', () => {
    expect(storyMemory(series, 'chapter-3')).toBe(
      '前情提要：\n第 1 话：第一话的事。\n第 2 话：第二话的事。\n\n已确定的设定：\n- 阿秋左眉的疤是十岁时留下的',
    )
    expect(storyMemory(mangaSeriesFixture({ facts: [] }), 'chapter-1')).toBe('')
  })

  it('drops the oldest summaries first when the memory is too long', () => {
    const memory = storyMemory(series, 'chapter-3', 45)
    expect(memory).toContain('第 2 话')
    expect(memory).not.toContain('第 1 话')
    expect(memory).toContain('（更早的 1 话已省略）')
  })
})

describe('chapter memory from the language model', () => {
  it('asks for a summary and new facts with the script of the chapter', () => {
    const series = mangaSeriesFixture()
    const request = memoryRequest(series, series.chapters[0]!)
    expect(request.system).toContain('{"summary"')
    expect(request.user).toContain('1. 雨夜的街道，霓虹灯倒映在积水里\n   旁白：那天，雨一直没停。')
    expect(request.user).toContain('   莲：有新委托。')
    expect(request.user).toContain('- 阿秋左眉的疤是十岁时留下的')
  })

  it('reads the answer, fenced or not', () => {
    expect(parseMemory('```json\n{"summary": " 接下委托 ", "facts": ["莲有车", " "]}\n```')).toEqual({
      summary: '接下委托',
      facts: ['莲有车'],
    })
    expect(parseMemory('{"summary": "只有摘要"}')).toEqual({ summary: '只有摘要', facts: [] })
    expect(() => parseMemory('{"summary": 3}')).toThrow('语言模型返回的剧情记忆格式不对，请再试一次')
    expect(extractJson('前言 {"a": {"b": 1}} 后记')).toEqual({ a: { b: 1 } })
  })

  it("replaces a chapter's own facts and keeps the author's", () => {
    let next = 0
    const facts = [
      { id: 'f-author', text: '作者写的' },
      { id: 'f-old', text: '旧事实', chapterId: 'chapter-1' },
      { id: 'f-other', text: '别的话', chapterId: 'chapter-2' },
    ]
    expect(mergeFacts(facts, 'chapter-1', ['新事实', '作者写的'], () => `f-${++next}`)).toEqual([
      { id: 'f-author', text: '作者写的' },
      { id: 'f-other', text: '别的话', chapterId: 'chapter-2' },
      { id: 'f-1', text: '新事实', chapterId: 'chapter-1' },
    ])
  })
})
