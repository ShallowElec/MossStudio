import { BookOpenText, Brain, CheckCheck, Download, FilePlus2, Play, Plus, Sparkles, Square, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import { PAGE_LAYOUTS } from '@shared/manga/layouts'
import { memoryRequest, mergeFacts, parseMemory } from '@shared/manga/memory'
import { newId, type MangaChapter, type MangaSeries } from '@shared/manga/model'
import { chapterProgress, dequeue, enqueue, updatePanel } from '@shared/manga/queue'
import { parseStoryboard, storyboardRequest } from '@shared/manga/storyboard'
import { call } from '../../lib/api'
import { Notice } from '../../components/common/Notice'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Group,
  IconButton,
  Input,
  ProgressBar,
  Row,
  Section,
  Select,
  Textarea,
  useToast,
} from '../../components/ui'
import { PanelCard } from './PanelCard'
import {
  approveAll,
  changeLayout,
  chapterLabel,
  exportBlockers,
  newChapter,
  newPage,
  nextChapterNumber,
  panelsInUse,
  updateChapter,
  updatePage,
} from './logic'
import { PagePreview, askModel, useProviders } from './parts'
import { renderPagePng, type PictureCache } from './render'
import type { SeriesUpdate } from './useSeries'

export function ChapterTab({ series, update }: { series: MangaSeries; update: SeriesUpdate }): React.JSX.Element {
  const ordered = useMemo(() => [...series.chapters].sort((a, b) => a.number - b.number), [series.chapters])
  const [selectedId, setSelectedId] = useState<string | null>(ordered.at(-1)?.id ?? null)
  const chapter = ordered.find((item) => item.id === selectedId) ?? ordered.at(-1) ?? null

  const add = (): void => {
    const created = newChapter(nextChapterNumber(series))
    update((current) => ({ ...current, chapters: [...current.chapters, created] }))
    setSelectedId(created.id)
  }

  return (
    <div className="flex min-h-0 gap-6">
      <div className="flex w-56 shrink-0 flex-col gap-2">
        {ordered.length ? (
          <Group>
            {ordered.map((item) => {
              const progress = chapterProgress(item)
              return (
                <Row
                  key={item.id}
                  title={chapterLabel(item)}
                  description={progress.total ? `${progress.approved} / ${progress.total} 格已通过` : '还没有分镜'}
                  selected={item.id === chapter?.id}
                  onClick={() => setSelectedId(item.id)}
                />
              )
            })}
          </Group>
        ) : null}
        <Button onClick={add}>
          <Plus className="size-4" strokeWidth={1.6} /> 新建一话
        </Button>
      </div>
      {chapter ? (
        <ChapterEditor key={chapter.id} series={series} chapter={chapter} update={update} onRemoved={() => setSelectedId(null)} />
      ) : (
        <EmptyState
          size="section"
          icon={<BookOpenText className="size-8" strokeWidth={1.6} />}
          title="还没有章节"
          description="新建一话，写下大纲，让语言模型拆成分镜。"
        />
      )}
    </div>
  )
}

function ChapterEditor({
  series,
  chapter,
  update,
  onRemoved,
}: {
  series: MangaSeries
  chapter: MangaChapter
  update: SeriesUpdate
  onRemoved: () => void
}): React.JSX.Element {
  const toast = useToast()
  const { providers } = useProviders()
  const [pageCount, setPageCount] = useState(6)
  const [busy, setBusy] = useState<'storyboard' | 'memory' | 'export' | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'replace' | 'remove' | null>(null)
  const pictures = useMemo<PictureCache>(() => new Map(), [])
  const progress = chapterProgress(chapter)
  const drawing = progress.queued + progress.running > 0
  const setChapter = (change: (current: MangaChapter) => MangaChapter): void =>
    update((current) => updateChapter(current, chapter.id, change))
  const blocker = exportBlockers(chapter)

  const storyboard = async (): Promise<void> => {
    setConfirm(null)
    setBusy('storyboard')
    setError(null)
    setWarnings([])
    try {
      const answer = await askModel(series, storyboardRequest(series, chapter, { pages: pageCount }), providers)
      const parsed = parseStoryboard(answer, series, newId)
      setChapter((current) => ({ ...current, pages: parsed.pages }))
      setWarnings(parsed.warnings)
      toast.push(`分镜好了：${parsed.pages.length} 页，${parsed.pages.reduce((sum, page) => sum + page.panels.length, 0)} 格`, 'success')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const remember = async (): Promise<void> => {
    setBusy('memory')
    setError(null)
    try {
      const answer = await askModel(series, memoryRequest(series, chapter), providers)
      const memory = parseMemory(answer)
      update((current) => ({
        ...updateChapter(current, chapter.id, (item) => ({ ...item, summary: memory.summary })),
        facts: mergeFacts(current.facts, chapter.id, memory.facts, () => newId('fact')),
      }))
      toast.push(`已记下这一话，新增 ${memory.facts.length} 条设定`, 'success')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const exportChapter = async (): Promise<void> => {
    setBusy('export')
    setError(null)
    try {
      const pages: Uint8Array[] = []
      for (const [index, page] of chapter.pages.entries()) pages.push(await renderPagePng(series, page, pictures, `第 ${index + 1} 页`))
      const folder = await call<string | null>(Ipc.mangaExport, { title: series.title, chapterNumber: chapter.number, pages })
      if (folder) toast.push(`已导出 ${pages.length} 页到 ${folder}`, 'success')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-8" role="region" aria-label={chapterLabel(chapter)}>
      <Section
        title="剧情大纲"
        actions={
          <Button tone="ghost-danger" size="xs" onClick={() => setConfirm('remove')}>
            <Trash2 className="size-3.5" strokeWidth={1.6} /> 删除这一话
          </Button>
        }
      >
        <div className="flex gap-4">
          <Field label="话数" className="w-20">
            <Input
              type="number"
              min={1}
              value={chapter.number}
              onChange={(event) => {
                const number = Math.max(1, Math.min(9999, Math.round(Number(event.target.value) || 1)))
                setChapter((current) => ({ ...current, number }))
              }}
            />
          </Field>
          <Field label="标题" className="flex-1">
            <Input
              value={chapter.title}
              maxLength={200}
              onChange={(event) => setChapter((current) => ({ ...current, title: event.target.value }))}
            />
          </Field>
        </div>
        <Field label="大纲" hint="这一话发生什么、谁出场、在哪里结束。写得越具体，分镜越贴近你想要的。">
          <Textarea
            rows={6}
            value={chapter.outline}
            onChange={(event) => setChapter((current) => ({ ...current, outline: event.target.value }))}
          />
        </Field>
        <div className="flex items-end gap-2">
          <Field label="大约几页" className="w-24">
            <Input
              type="number"
              min={1}
              max={40}
              value={pageCount}
              onChange={(event) => setPageCount(Math.max(1, Math.min(40, Number(event.target.value) || 1)))}
            />
          </Field>
          <Button
            tone={chapter.pages.length ? 'secondary' : 'primary'}
            disabled={!chapter.outline.trim() || busy !== null || drawing}
            title={drawing ? '先停止生成' : undefined}
            onClick={() => (chapter.pages.length ? setConfirm('replace') : void storyboard())}
          >
            <Sparkles className="size-4" strokeWidth={1.6} />{' '}
            {busy === 'storyboard' ? '正在拆分镜…' : chapter.pages.length ? '重新生成分镜' : '生成分镜'}
          </Button>
          <Button disabled={busy !== null} onClick={() => setChapter((current) => ({ ...current, pages: [...current.pages, newPage()] }))}>
            <FilePlus2 className="size-4" strokeWidth={1.6} /> 加一页
          </Button>
        </div>
        {busy === 'storyboard' ? <ProgressBar value={null} label="正在拆分镜" /> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {warnings.length ? (
          <Notice tone="warn" title="分镜有几处自动调整了">
            {warnings.join('；')}
          </Notice>
        ) : null}
      </Section>

      {chapter.pages.length ? (
        <Section
          title="出图与审核"
          description={`${progress.approved} / ${progress.total} 格已通过${progress.review ? `，${progress.review} 格待审核` : ''}${progress.failed ? `，${progress.failed} 格失败` : ''}`}
        >
          <ProgressBar value={progress.total ? (progress.approved / progress.total) * 100 : 0} label="审核进度" />
          <div className="flex flex-wrap gap-2">
            {drawing ? (
              <Button onClick={() => update((current) => dequeue(current, chapter.id))}>
                <Square className="size-4" strokeWidth={1.6} /> 停止排队
              </Button>
            ) : (
              <Button
                tone="primary"
                disabled={progress.draft + progress.failed === 0}
                onClick={() => update((current) => enqueue(current, chapter.id))}
              >
                <Play className="size-4" strokeWidth={1.6} /> 生成全部
              </Button>
            )}
            <Button disabled={!progress.review} onClick={() => update((current) => approveAll(current, chapter.id))}>
              <CheckCheck className="size-4" strokeWidth={1.6} /> 全部通过
            </Button>
            <Button disabled={busy !== null} onClick={() => void remember()}>
              <Brain className="size-4" strokeWidth={1.6} /> {busy === 'memory' ? '正在记下…' : '写入剧情记忆'}
            </Button>
            <Button disabled={busy !== null || Boolean(blocker)} title={blocker ?? undefined} onClick={() => void exportChapter()}>
              <Download className="size-4" strokeWidth={1.6} /> {busy === 'export' ? '正在导出…' : '导出这一话'}
            </Button>
          </div>
        </Section>
      ) : null}

      {chapter.pages.map((page, pageIndex) => {
        const inUse = panelsInUse(page)
        return (
          <Section
            key={page.id}
            title={`第 ${pageIndex + 1} 页`}
            actions={
              <>
                <Select
                  aria-label={`第 ${pageIndex + 1} 页的分格`}
                  value={page.layoutId}
                  onValueChange={(layoutId) =>
                    update((current) => updatePage(current, chapter.id, page.id, (item) => changeLayout(item, layoutId)))
                  }
                  options={PAGE_LAYOUTS.map((layout) => ({
                    value: layout.id,
                    label: `${layout.label}（${layout.rects.length} 格）`,
                    disabled: layout.rects.length < inUse,
                  }))}
                />
                <IconButton
                  label={`删除第 ${pageIndex + 1} 页`}
                  onClick={() => setChapter((current) => ({ ...current, pages: current.pages.filter((item) => item.id !== page.id) }))}
                >
                  <Trash2 className="size-4" strokeWidth={1.6} />
                </IconButton>
              </>
            }
          >
            <div className="flex items-start gap-4">
              <div className="sticky top-0 w-56 shrink-0">
                <PagePreview series={series} page={page} label={`第 ${pageIndex + 1} 页预览`} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                {page.panels.map((panel, panelIndex) => (
                  <PanelCard
                    key={panel.id}
                    series={series}
                    panel={panel}
                    label={`第 ${pageIndex + 1} 页第 ${panelIndex + 1} 格`}
                    onChange={(change) => update((current) => updatePanel(current, chapter.id, panel.id, change))}
                    onDraw={() => update((current) => enqueue(current, chapter.id, [panel.id]))}
                  />
                ))}
              </div>
            </div>
          </Section>
        )
      })}

      <ConfirmDialog
        open={confirm === 'replace'}
        title="重新生成分镜？"
        description="现在的页面、格子和已经画好的图会被新的分镜替换。已经生成的图片仍保留在「作品」里。"
        confirmLabel="重新生成"
        onClose={() => setConfirm(null)}
        onConfirm={() => void storyboard()}
      />
      <ConfirmDialog
        open={confirm === 'remove'}
        title={`删除${chapterLabel(chapter)}？`}
        description="这一话的大纲、分镜和剧情记忆会删除。已经生成的图片仍保留在「作品」里。"
        confirmLabel="删除"
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
          update((current) => ({
            ...current,
            chapters: current.chapters.filter((item) => item.id !== chapter.id),
            facts: current.facts.filter((fact) => fact.chapterId !== chapter.id),
          }))
          onRemoved()
        }}
      />
    </div>
  )
}
