import { Plus, X } from 'lucide-react'
import { useMemo } from 'react'
import { MEMORY_BUDGET, storyMemory } from '@shared/manga/memory'
import { newId, type MangaSeries } from '@shared/manga/model'
import { Button, EmptyState, Field, IconButton, Input, Section, Textarea } from '../../components/ui'
import { chapterLabel, updateChapter } from './logic'
import type { SeriesUpdate } from './useSeries'

/**
 * 剧情记忆: what the language model is told about earlier chapters when it
 * storyboards the next one. Summaries and facts are written by 写入剧情记忆
 * and can be corrected here.
 */
export function MemoryTab({ series, update }: { series: MangaSeries; update: SeriesUpdate }): React.JSX.Element {
  const ordered = useMemo(() => [...series.chapters].sort((a, b) => a.number - b.number), [series.chapters])
  const next = ordered.at(-1)
  const used = next
    ? storyMemory({ ...series, chapters: [...series.chapters, { ...next, id: '__next', number: next.number + 1 }] }, '__next')
    : ''

  return (
    <div className="flex max-w-[760px] flex-col gap-8">
      <Section
        title="设定"
        description="之后的每一话都不能写错的事：人物关系、伤势、物品、秘密、约定。写入剧情记忆时会自动补充。"
        actions={
          <Button
            size="xs"
            onClick={() => update((current) => ({ ...current, facts: [...current.facts, { id: newId('fact'), text: '新设定' }] }))}
          >
            <Plus className="size-3.5" strokeWidth={1.6} /> 添加
          </Button>
        }
      >
        {series.facts.length ? (
          <div className="flex flex-col gap-1.5">
            {series.facts.map((fact, index) => (
              <div key={fact.id} className="flex items-center gap-2">
                <Input
                  aria-label={`设定 ${index + 1}`}
                  className="flex-1"
                  value={fact.text}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      facts: current.facts.map((item) => (item.id === fact.id ? { ...item, text: event.target.value } : item)),
                    }))
                  }
                  onBlur={(event) =>
                    // An emptied fact is removed rather than kept blank (the schema needs text).
                    !event.target.value.trim() &&
                    update((current) => ({ ...current, facts: current.facts.filter((item) => item.id !== fact.id) }))
                  }
                />
                <IconButton
                  label={`删除设定 ${index + 1}`}
                  onClick={() => update((current) => ({ ...current, facts: current.facts.filter((item) => item.id !== fact.id) }))}
                >
                  <X className="size-4" strokeWidth={1.6} />
                </IconButton>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState size="section" title="还没有设定" description="画完一话后点「写入剧情记忆」，语言模型会记下这一话的新设定。" />
        )}
      </Section>

      <Section title="前情提要" description="每一话发生了什么。下一话分镜时，最近的几话会交给语言模型。">
        {ordered.map((chapter) => (
          <Field key={chapter.id} label={chapterLabel(chapter)}>
            <Textarea
              rows={2}
              value={chapter.summary}
              placeholder="还没有记下这一话"
              onChange={(event) =>
                update((current) => updateChapter(current, chapter.id, (item) => ({ ...item, summary: event.target.value })))
              }
            />
          </Field>
        ))}
      </Section>

      <Section title="下一话会带上的内容" description={`前情提要和设定合计最多约 ${MEMORY_BUDGET} 字，太长时先省略最早的几话。`}>
        <p className="selectable whitespace-pre-wrap rounded-lg bg-well px-3 py-2.5 text-ui leading-relaxed text-ink">
          {used || <span className="text-ink-2">还没有记下任何内容</span>}
        </p>
      </Section>
    </div>
  )
}
