import { Check, Images, RefreshCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ipc, Events } from '@shared/channels'
import type { GalleryItem, JobRecord, ProjectSummary } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { cloverUrl } from '../../lib/clover'
import { Notice } from '../../components/common/Notice'
import { Button, EmptyState, IconButton, Input, LoadingRow, PageHeader, Select, cn } from '../../components/ui'
import { usePictureActions } from '../../lib/usePictureActions'
import { overlaps, type Rect } from '../studio/boardLayout'
import { BoardMenu } from '../studio/BoardMenu'
import { boxBetween } from '../studio/selection'
import { DetailPanel } from './DetailPanel'
import {
  EMPTY_FILTERS,
  TIME_FILTERS,
  afterRemoval,
  clickPick,
  countLabel,
  groupByDay,
  hasFilters,
  joinPicks,
  listedPicks,
  stepIndex,
  type LibraryFilters,
  type TimeFilter,
} from './logic'
import { SelectionBar } from './SelectionBar'
import { useGallery } from './useGallery'

/** How far (pixels) a press on empty space must move before it draws a box. */
const BOX_START = 4

function useProjects(): ProjectSummary[] {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const load = useCallback(() => {
    call<ProjectSummary[]>(Ipc.projectsList)
      .then(setProjects)
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    load()
    // A new project usually appears together with its first finished job.
    return onEvent<JobRecord>(Events.job, (job) => {
      if (job.state === 'succeeded') load()
    })
  }, [load])
  return projects
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** 作品: every generated image, grouped by day, with a detail panel on the right. */
export function LibraryPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS)
  const gallery = useGallery(filters)
  const projects = useProjects()
  /** The picked pictures, in listing order. One shows the detail panel; several, the selection bar. */
  const [picked, setPicked] = useState<string[]>([])
  /** Where a Shift range starts: the tile of the last plain or Ctrl click. */
  const anchor = useRef<string | null>(null)
  const [box, setBox] = useState<Rect | null>(null)
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; bounds: { width: number; height: number }; path: string } | null>(null)
  const pictures = usePictureActions()
  const sentinel = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setFilters((current) => ({ ...current, query: search })), 260)
    return () => window.clearTimeout(timer)
  }, [search])

  const { items, total, cursor, loading, error, loaded, loadMore, reload, remove } = gallery
  const groups = useMemo(() => groupByDay(items), [items])
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects])
  const order = useMemo(() => items.map((item) => item.path), [items])
  const pickedSet = useMemo(() => new Set(picked), [picked])
  const selectedPath = picked.length === 1 ? picked[0]! : null
  const selectedIndex = selectedPath ? items.findIndex((item) => item.path === selectedPath) : -1
  const selected: GalleryItem | null = selectedIndex >= 0 ? items[selectedIndex]! : null
  const setSelectedPath = useCallback((path: string | null) => setPicked(path ? [path] : []), [])

  // Drop picks whose image left the listing (filters changed, deleted elsewhere); the panel closes with its image.
  useEffect(() => {
    if (loaded && !loading) setPicked((current) => listedPicks(current, order))
  }, [loaded, loading, order])

  useEffect(() => {
    const element = sentinel.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore()
      },
      { root: scroller.current, rootMargin: '600px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [loadMore, cursor])

  const select = useCallback(
    (path: string) => {
      setSelectedPath(path)
      anchor.current = path
      document.querySelector(`[data-library-item="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' })
    },
    [setSelectedPath],
  )

  // "Next" on the last loaded image waits for the next page, then moves on.
  const pendingNext = useRef<string | null>(null)
  useEffect(() => {
    const from = pendingNext.current
    if (!from || loading) return
    pendingNext.current = null
    const index = stepIndex(items, from, 1)
    if (index >= 0 && items[index]!.path !== from && selectedPath === from) select(items[index]!.path)
  }, [items, loading, select, selectedPath])

  const step = useCallback(
    (delta: -1 | 1) => {
      if (!selectedPath) return
      const index = stepIndex(items, selectedPath, delta)
      if (index < 0) return
      if (delta > 0 && index >= items.length - 3) void loadMore()
      if (items[index]!.path === selectedPath) {
        if (delta > 0 && cursor) pendingNext.current = selectedPath
        return
      }
      select(items[index]!.path)
    },
    [cursor, items, loadMore, select, selectedPath],
  )

  const anyPicked = picked.length > 0
  useEffect(() => {
    if (!anyPicked) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTyping(event.target) || document.querySelector('dialog[open]')) return
      // Pages stay mounted while hidden; only react while the Library is on screen.
      if (!root.current || root.current.offsetParent === null) return
      if (event.key === 'ArrowLeft' && selectedPath) step(-1)
      else if (event.key === 'ArrowRight' && selectedPath) step(1)
      else if (event.key === 'Escape') setPicked([])
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [anyPicked, selectedPath, step])

  const itemsRef = useRef(items)
  itemsRef.current = items
  const onDeleted = useCallback(
    (path: string) => {
      const next = afterRemoval(itemsRef.current, path)
      remove(path)
      // The user may have stepped to another image while the delete was running.
      setPicked((current) =>
        current.length === 1 && current[0] === path ? (next ? [next.path] : []) : current.filter((item) => item !== path),
      )
    },
    [remove],
  )
  const onDeletedMany = useCallback(
    (paths: string[]) => {
      for (const path of paths) remove(path)
      const gone = new Set(paths)
      setPicked((current) => current.filter((path) => !gone.has(path)))
    },
    [remove],
  )

  const pickByClick = (event: React.MouseEvent, path: string): void => {
    const toggle = event.ctrlKey || event.metaKey
    const range = event.shiftKey
    setPicked((current) => listedPicks(clickPick(current, path, order, { toggle, range, anchor: anchor.current }), order))
    if (!range) anchor.current = path
  }

  const openMenu = (event: React.MouseEvent, path: string): void => {
    event.preventDefault()
    const rect = root.current?.getBoundingClientRect()
    if (!rect) return
    // A picture outside the picks becomes the pick, as in a file manager.
    if (!pickedSet.has(path)) {
      setPicked([path])
      anchor.current = path
    }
    setMenu({ at: { x: event.clientX - rect.left, y: event.clientY - rect.top }, bounds: { width: rect.width, height: rect.height }, path })
  }

  // A press on empty space between the tiles draws a box that picks every tile it touches;
  // with Ctrl, ⌘ or Shift held they join the picks, and a press that does not move lets them all go.
  const startBox = (event: React.PointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (event.button !== 0 || target.closest('[data-library-item], button, a, input, select, textarea, [role="toolbar"]')) return
    const element = event.currentTarget
    // A press on the scrollbar scrolls; clientWidth stops where the scrollbar starts.
    if (event.clientX - element.getBoundingClientRect().left >= element.clientWidth) return
    const pointerId = event.pointerId
    const origin = { x: event.clientX, y: event.clientY }
    const base = event.ctrlKey || event.metaKey || event.shiftKey ? picked : []
    let moved = false
    element.setPointerCapture(pointerId)
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      if (!moved && Math.hypot(next.clientX - origin.x, next.clientY - origin.y) < BOX_START) return
      moved = true
      const screen = boxBetween(origin, { x: next.clientX, y: next.clientY })
      const touched = [...element.querySelectorAll<HTMLElement>('[data-library-item]')]
        .filter((tile) => {
          const rect = tile.getBoundingClientRect()
          return overlaps({ x: rect.left, y: rect.top, w: rect.width, h: rect.height }, screen)
        })
        .map((tile) => tile.dataset.libraryItem!)
      setPicked(listedPicks(joinPicks(base, touched), order))
      const frame = element.getBoundingClientRect()
      setBox({ ...screen, x: screen.x - frame.left, y: screen.y - frame.top + element.scrollTop })
    }
    const stop = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', stop)
      element.removeEventListener('pointercancel', stop)
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
      setBox(null)
      if (!moved && next.type === 'pointerup' && !base.length) setPicked([])
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', stop)
    element.addEventListener('pointercancel', stop)
  }

  const filtered = hasFilters(filters)
  const clearFilters = (): void => {
    setSearch('')
    setFilters(EMPTY_FILTERS)
  }

  return (
    <div ref={root} className="relative flex h-full bg-surface">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* PageHeader with the same insets as PageScroll, so the title sits where every page puts it. */}
        <PageHeader
          className="shrink-0 px-10 pb-4 pt-8"
          title="作品"
          description={loaded && !error ? countLabel(total) : undefined}
          actions={
            <>
              <label className="relative block">
                <span className="sr-only">搜索作品</span>
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-2"
                  strokeWidth={1.6}
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索提示词或文件名"
                  className="w-60 pl-8"
                />
              </label>
              <Select
                aria-label="按项目筛选"
                value={filters.projectId}
                onValueChange={(projectId) => setFilters((current) => ({ ...current, projectId }))}
                className="w-40"
                options={[{ value: '', label: '全部项目' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
              />
              <Select
                aria-label="按时间筛选"
                value={filters.time}
                onValueChange={(time) => setFilters((current) => ({ ...current, time: time as TimeFilter }))}
                className="w-32"
                options={TIME_FILTERS}
              />
              <IconButton label="刷新" disabled={loading} onClick={reload}>
                <RefreshCw className={cn('size-4', loading && 'animate-spin')} strokeWidth={1.6} />
              </IconButton>
            </>
          }
        />

        <div
          ref={scroller}
          onPointerDown={startBox}
          className={cn('relative min-h-0 flex-1 select-none overflow-y-auto px-10 pb-10', picked.length > 1 && 'pb-24')}
        >
          {error && items.length === 0 ? (
            <EmptyState
              icon={<Images className="size-8" strokeWidth={1.6} />}
              title="作品读取失败"
              description={`${error}。检查图片文件夹是否还在，然后重试。`}
              action={
                <div className="flex gap-2">
                  <Button tone="primary" onClick={reload}>
                    重试
                  </Button>
                  <Button tone="secondary" onClick={() => navigate('/settings/storage')}>
                    查看图片文件夹
                  </Button>
                </div>
              }
            />
          ) : !loaded ? (
            <LoadingRow className="justify-center py-20" />
          ) : items.length === 0 ? (
            filtered ? (
              <EmptyState
                icon={<Search className="size-8" strokeWidth={1.6} />}
                title="没有符合条件的作品"
                description="换个关键词，或者放宽项目和时间筛选。"
                action={
                  <Button tone="secondary" onClick={clearFilters}>
                    <X className="size-4" strokeWidth={1.6} /> 清除筛选
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Images className="size-8" strokeWidth={1.6} />}
                title="还没有作品"
                description="在创作中生成的图片会出现在这里。也可以添加电脑上已有的图片文件夹。"
                action={
                  <div className="flex gap-2">
                    <Button tone="primary" onClick={() => navigate('/studio')}>
                      去创作
                    </Button>
                    <Button tone="secondary" onClick={() => navigate('/settings/storage')}>
                      添加图片文件夹
                    </Button>
                  </div>
                }
              />
            )
          ) : (
            <div className="flex flex-col gap-6">
              {groups.map((group) => (
                <section key={group.key} aria-label={group.label} className="flex flex-col gap-2.5">
                  <h2 className="text-ui font-semibold text-ink-2">{group.label}</h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2">
                    {group.items.map((item) => {
                      const on = pickedSet.has(item.path)
                      return (
                        <button
                          key={item.id}
                          type="button"
                          data-library-item={item.path}
                          aria-label={item.prompt ? `${item.name}：${item.prompt.slice(0, 60)}` : item.name}
                          aria-pressed={on}
                          draggable
                          onDragStart={(event) => {
                            // Out of the window as files: the picks when this tile is one of them, else this one.
                            event.preventDefault()
                            pictures.dragOut(on && picked.length > 1 ? picked : [item.path])
                          }}
                          onClick={(event) => pickByClick(event, item.path)}
                          onContextMenu={(event) => openMenu(event, item.path)}
                          className={cn(
                            'group relative aspect-square overflow-hidden rounded-lg bg-panel outline-offset-2 transition-opacity',
                            on ? 'outline-2 outline-accent' : 'hover:opacity-90',
                          )}
                          style={{ contentVisibility: 'auto', containIntrinsicSize: '160px' }}
                        >
                          <img
                            src={cloverUrl(item.path)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            draggable={false}
                            className="size-full object-cover"
                          />
                          {on ? (
                            <span
                              aria-hidden="true"
                              data-picked-badge
                              className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-accent text-on-accent shadow-float"
                            >
                              <Check className="size-3.5" strokeWidth={2.4} />
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}

          <div ref={sentinel} className="flex h-14 items-center justify-center">
            {items.length > 0 && loading ? <LoadingRow label="正在读取更多…" /> : null}
            {items.length > 0 && !loading && error ? (
              <Notice
                tone="danger"
                action={
                  <Button size="xs" onClick={() => void loadMore()}>
                    重试
                  </Button>
                }
              >
                没能读取更多图片
              </Notice>
            ) : null}
          </div>

          {/* The empty states already say where pictures come from. */}
          {items.length > 0 ? (
            <p className="text-center text-caption text-ink-2">
              图片来自输出目录和你添加的文件夹。
              <Button tone="ghost" size="xs" onClick={() => navigate('/settings/storage')}>
                在 设置 › 存储 中管理
              </Button>
            </p>
          ) : null}
          {box ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute rounded-sm bg-accent-soft"
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            />
          ) : null}
        </div>

        {picked.length > 1 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-6">
            <SelectionBar paths={picked} onClear={() => setPicked([])} onDeleted={onDeletedMany} />
          </div>
        ) : null}
      </div>

      {menu ? (
        <BoardMenu label="图片操作" entries={pictures.menu(menu.path)} at={menu.at} bounds={menu.bounds} onClose={() => setMenu(null)} />
      ) : null}

      {selected ? (
        <DetailPanel
          item={selected}
          position={selectedIndex + 1}
          total={total}
          canPrevious={selectedIndex > 0}
          canNext={selectedIndex < items.length - 1 || Boolean(cursor)}
          projectNames={projectNames}
          onStep={step}
          onClose={() => setSelectedPath(null)}
          onDeleted={onDeleted}
        />
      ) : null}
    </div>
  )
}
