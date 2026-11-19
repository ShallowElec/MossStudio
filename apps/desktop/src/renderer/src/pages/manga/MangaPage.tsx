import { BookOpen, ChevronLeft, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Ipc } from '@shared/channels'
import { chapterProgress } from '@shared/manga/queue'
import type { MangaSeries } from '@shared/manga/model'
import { call } from '../../lib/api'
import { cloverUrl } from '../../lib/clover'
import { Notice } from '../../components/common/Notice'
import { Button, EmptyState, LoadingRow, PageHeader, PageScroll, Pill, Tabs, useToast } from '../../components/ui'
import { CharactersTab } from './CharactersTab'
import { ChapterTab } from './ChapterTab'
import { MemoryTab } from './MemoryTab'
import { SettingsTab } from './SettingsTab'
import { newSeries } from './logic'
import { readOpenSeries, writeOpenSeries } from './preferences'
import { useDrawingQueue } from './useDrawingQueue'
import { useSeriesDocument, useSeriesList } from './useSeries'

type Tab = 'chapters' | 'characters' | 'memory' | 'settings'

/** 漫画: a list of series; opening one shows its chapters, characters, memory and settings. */
export function MangaPage(): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(() => readOpenSeries())
  const open = useCallback((id: string | null) => {
    setOpenId(id)
    writeOpenSeries(id)
  }, [])
  return openId ? <SeriesWorkspace id={openId} onClose={() => open(null)} /> : <SeriesHome onOpen={open} />
}

function SeriesHome({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element {
  const toast = useToast()
  const { items, loaded, error, reload } = useSeriesList()
  const [creating, setCreating] = useState(false)

  const create = async (): Promise<void> => {
    setCreating(true)
    try {
      const series = await call<MangaSeries>(Ipc.mangaSave, newSeries())
      onOpen(series.id)
    } catch (reason) {
      toast.push(reason instanceof Error ? reason.message : String(reason), 'error')
    } finally {
      setCreating(false)
    }
  }

  return (
    <PageScroll>
      <PageHeader
        title="漫画"
        description="把故事做成连载漫画：写大纲，语言模型拆分镜，按人物卡出图，审核后排版导出。"
        actions={
          items.length ? (
            <Button tone="primary" disabled={creating} onClick={() => void create()}>
              <Plus className="size-4" strokeWidth={1.6} /> 新建漫画
            </Button>
          ) : undefined
        }
      />
      {error ? (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={reload}>
              重试
            </Button>
          }
        >
          漫画列表读取失败：{error}
        </Notice>
      ) : !loaded ? (
        <LoadingRow />
      ) : items.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              data-manga-series={item.id}
              aria-label={item.title}
              onClick={() => onOpen(item.id)}
              className="flex min-w-0 flex-col gap-2 rounded-xl bg-panel p-2 text-left transition-colors hover:bg-well"
            >
              <SeriesCover key={item.cover} path={item.cover} />
              <span className="flex items-center gap-1.5 px-1">
                <span className="min-w-0 flex-1 truncate text-control text-ink">{item.title}</span>
                <Pill tone={item.panels && item.approved === item.panels ? 'ok' : 'neutral'}>
                  {item.approved} / {item.panels} 格
                </Pill>
              </span>
              <span className="truncate px-1 pb-1 text-caption text-ink-2" title={item.logline || undefined}>
                {item.chapterCount} 话 · {item.characterCount} 个人物
              </span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<BookOpen className="size-8" strokeWidth={1.6} />}
          title="还没有漫画"
          description="新建一部漫画，先建好人物卡，再一话一话地写。"
          action={
            <Button tone="primary" disabled={creating} onClick={() => void create()}>
              <Plus className="size-4" strokeWidth={1.6} /> 新建漫画
            </Button>
          }
        />
      )}
    </PageScroll>
  )
}

/** A series' cover, or its placeholder when it has none or the picture cannot be read (deleted from 作品). */
function SeriesCover({ path }: { path: string | null }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  return path && !failed ? (
    <img
      src={cloverUrl(path)}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      className="aspect-square w-full rounded-md bg-[var(--image-placeholder)] object-cover"
    />
  ) : (
    <span className="flex aspect-square w-full items-center justify-center rounded-md bg-well text-ink-2" data-cover-missing="">
      <BookOpen className="size-6" strokeWidth={1.6} aria-hidden="true" />
    </span>
  )
}

function SeriesWorkspace({ id, onClose }: { id: string; onClose: () => void }): React.JSX.Element {
  const toast = useToast()
  const { series, loading, error, saveError, update, current, saveNow } = useSeriesDocument(id)
  const [tab, setTab] = useState<Tab>('chapters')
  const notify = useCallback((message: string, tone: 'info' | 'error') => toast.push(message, tone), [toast])
  useDrawingQueue({ series, current, update, notify })

  // Leaving the page or the app keeps the last edits.
  useEffect(() => {
    const flush = (): void => void saveNow()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [saveNow])

  // A failed save keeps the workspace open: its edits exist nowhere else, and the notice says so.
  const close = (): void => {
    void saveNow().then((saved) => {
      if (saved) onClose()
    })
  }

  const remove = async (): Promise<void> => {
    try {
      await call(Ipc.mangaDelete, { id })
      toast.push('漫画已删除', 'success')
      onClose()
    } catch (reason) {
      toast.push(reason instanceof Error ? reason.message : String(reason), 'error')
    }
  }

  if (error) {
    return (
      <PageScroll>
        <EmptyState
          title="这部漫画打不开"
          description={error}
          action={
            <Button tone="primary" onClick={onClose}>
              回到漫画列表
            </Button>
          }
        />
      </PageScroll>
    )
  }
  if (loading || !series) {
    return (
      <PageScroll>
        <LoadingRow />
      </PageScroll>
    )
  }

  const panels = series.chapters.reduce(
    (sum, chapter) => {
      const progress = chapterProgress(chapter)
      return { review: sum.review + progress.review, busy: sum.busy + progress.queued + progress.running }
    },
    { review: 0, busy: 0 },
  )

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex shrink-0 flex-col gap-4 px-10 pb-4 pt-8">
        <Button tone="ghost" className="-ml-2 self-start" onClick={close}>
          <ChevronLeft className="size-4" strokeWidth={1.6} aria-hidden="true" />
          全部漫画
        </Button>
        <PageHeader
          title={series.title}
          description={
            panels.busy ? `正在画 ${panels.busy} 格` : panels.review ? `${panels.review} 格等你审核` : series.logline || undefined
          }
        />
        <Tabs
          label="漫画分区"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'chapters', label: '章节', count: series.chapters.length },
            { value: 'characters', label: '人物', count: series.characters.length },
            { value: 'memory', label: '剧情记忆' },
            { value: 'settings', label: '设定' },
          ]}
        />
        {saveError ? (
          <Notice
            tone="danger"
            action={
              <Button size="xs" onClick={() => void saveNow()}>
                重试
              </Button>
            }
          >
            没有保存成功：{saveError}
          </Notice>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-10 pb-16">
        {tab === 'chapters' ? <ChapterTab series={series} update={update} /> : null}
        {tab === 'characters' ? <CharactersTab series={series} update={update} /> : null}
        {tab === 'memory' ? <MemoryTab series={series} update={update} /> : null}
        {tab === 'settings' ? <SettingsTab series={series} update={update} onDelete={() => void remove()} /> : null}
      </div>
    </div>
  )
}
