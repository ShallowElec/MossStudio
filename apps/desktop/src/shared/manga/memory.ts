import { z } from 'zod'
import type { MangaChapter, MangaFact, MangaSeries } from './model'

/**
 * 剧情记忆: what the language model must remember across chapters. Each
 * finished chapter keeps a short summary; facts (who knows what, injuries,
 * promises, where things are) are kept as a list the author can edit. The
 * context for a chapter is every earlier summary plus all facts, cut from the
 * oldest summaries first when it grows too long.
 */

/** Characters of context the memory may take in a request (about 3k Chinese tokens). */
export const MEMORY_BUDGET = 6000

export function chaptersBefore(series: Pick<MangaSeries, 'chapters'>, chapterId: string): MangaChapter[] {
  const target = series.chapters.find((chapter) => chapter.id === chapterId)
  if (!target) return []
  return series.chapters.filter((chapter) => chapter.number < target.number).sort((a, b) => a.number - b.number)
}

export function storyMemory(series: Pick<MangaSeries, 'chapters' | 'facts'>, chapterId: string, budget = MEMORY_BUDGET): string {
  const facts = series.facts.map((fact) => `- ${fact.text}`)
  const summaries = chaptersBefore(series, chapterId)
    .filter((chapter) => chapter.summary.trim())
    .map((chapter) => `第 ${chapter.number} 话${chapter.title ? `「${chapter.title}」` : ''}：${chapter.summary.trim()}`)
  const factBlock = facts.length ? `已确定的设定：\n${facts.join('\n')}` : ''
  let remaining = budget - factBlock.length
  // The most recent chapters matter most; older ones drop out first.
  const kept: string[] = []
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    const line = summaries[index]!
    if (line.length > remaining) {
      kept.unshift(`（更早的 ${index + 1} 话已省略）`)
      break
    }
    kept.unshift(line)
    remaining -= line.length + 1
  }
  const storyBlock = kept.length ? `前情提要：\n${kept.join('\n')}` : ''
  return [storyBlock, factBlock].filter(Boolean).join('\n\n')
}

/** Text a model wrapped in ```json fences or prose: the first JSON object in it. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1]! : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('语言模型没有返回可读的结果，请再试一次')
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown
  } catch {
    throw new Error('语言模型返回的结果格式不对，请再试一次')
  }
}

export interface MemoryRequest {
  system: string
  user: string
}

export function memoryRequest(
  series: Pick<MangaSeries, 'title' | 'characters' | 'chapters' | 'facts'>,
  chapter: MangaChapter,
): MemoryRequest {
  const panels = chapter.pages.flatMap((page) => page.panels)
  const names = new Map(series.characters.map((character) => [character.id, character.name]))
  const script = panels
    .map((panel, index) => {
      const lines = panel.dialogue.map((line) => `${line.speakerId ? (names.get(line.speakerId) ?? '某人') : '旁白'}：${line.text}`)
      return [`${index + 1}. ${panel.scene}`, ...lines.map((line) => `   ${line}`)].join('\n')
    })
    .join('\n')
  return {
    system: [
      '你是漫画连载的剧情记录员。读完一话的大纲和分镜后，写下之后各话必须记住的内容。',
      '只输出一个 JSON 对象，不要输出其他文字：',
      '{"summary": "这一话发生了什么，150 字以内", "facts": ["新确定的、之后不能写错的事实，每条一句话"]}',
      '事实只写新出现或改变的：人物关系、伤势、获得或失去的物品、秘密、约定、地点。已知设定不要重复。',
    ].join('\n'),
    user: [
      `作品：${series.title}`,
      series.facts.length ? `已知设定：\n${series.facts.map((fact) => `- ${fact.text}`).join('\n')}` : '',
      `第 ${chapter.number} 话${chapter.title ? `「${chapter.title}」` : ''}大纲：\n${chapter.outline}`,
      script ? `分镜与对白：\n${script}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  }
}

const memoryAnswer = z.object({
  summary: z.string().max(4000).default(''),
  facts: z.array(z.string().max(500)).max(50).default([]),
})

export function parseMemory(text: string): { summary: string; facts: string[] } {
  const parsed = memoryAnswer.safeParse(extractJson(text))
  if (!parsed.success) throw new Error('语言模型返回的剧情记忆格式不对，请再试一次')
  return {
    summary: parsed.data.summary.trim(),
    facts: parsed.data.facts.map((fact) => fact.trim()).filter(Boolean),
  }
}

/** A chapter's new facts replace the ones it set before; facts the author added stay. */
export function mergeFacts(facts: readonly MangaFact[], chapterId: string, texts: readonly string[], makeId: () => string): MangaFact[] {
  const kept = facts.filter((fact) => fact.chapterId !== chapterId)
  const known = new Set(kept.map((fact) => fact.text))
  const added = texts.filter((text) => !known.has(text)).map((text) => ({ id: makeId(), text, chapterId }))
  return [...kept, ...added]
}
