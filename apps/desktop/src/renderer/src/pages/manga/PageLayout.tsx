import { Camera, Check, Columns2, Dices, Merge, Rows2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import {
  LAYOUT_STYLES,
  LAYOUT_STYLE_LABEL,
  applyFrames,
  drawLayouts,
  drawShots,
  type LayoutDraw,
  type LayoutStyleId,
} from '@shared/manga/gacha'
import {
  MAX_FRAME_PANELS,
  PAGE_HEIGHT,
  PAGE_TEMPLATES,
  PAGE_WIDTH,
  PANEL_GUTTER,
  dragGutter,
  frameHandles,
  innerRect,
  isBleed,
  leafCount,
  panelQuads,
  setBleed,
  touchesEdge,
  type FrameHandle,
  type FrameNode,
  type Point,
  type Quad,
  type ReadingDirection,
} from '@shared/manga/layouts'
import { newId, type MangaPage, type MangaSeries } from '@shared/manga/model'
import { Notice } from '../../components/common/Notice'
import { Switch } from '../../components/form'
import { Button, FieldLabel, Segmented, Select, cn } from '../../components/ui'
import { applyTemplate, firstUsable, mergeBlocker, mergePanel, panelsInUse, splitBlocker, splitPanel } from './logic'
import { PagePreview } from './parts'

/**
 * 分格 of one page: the page preview with its frames on top. Click a panel to
 * pick it, drag a gutter (or focus it and use the arrow keys) to move it, cut
 * or merge the picked panel, let it bleed, start from a template, or draw a
 * batch of layouts and shots (抽卡, after Penna's 漫画分镜工作台).
 */

type PageChange = (change: (page: MangaPage) => MangaPage) => void

const points = (quad: Quad): string => quad.map((point) => `${point.x},${point.y}`).join(' ')
const NUDGE = 16
/** The badges sit on the page, which is white paper in both themes: print colours, as in render.ts, not theme tokens. */
const PRINT_INK = '#111111'
const PRINT_PAPER = '#ffffff'

function FrameOverlay({
  frames,
  direction,
  selected,
  onSelect,
  onDrag,
  label,
  editable,
}: {
  frames: FrameNode
  direction: ReadingDirection
  selected: number | null
  onSelect: (index: number) => void
  onDrag: (path: string, point: Point) => void
  label: string
  editable: boolean
}): React.JSX.Element {
  const svg = useRef<SVGSVGElement>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const quads = panelQuads(frames, direction)
  const handles = editable ? frameHandles(frames, direction) : []

  const toPage = (event: React.PointerEvent): Point | null => {
    const matrix = svg.current?.getScreenCTM()
    if (!matrix) return null
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return { x: point.x, y: point.y }
  }
  const nudge = (handle: FrameHandle, key: string): boolean => {
    const step = { ArrowUp: [0, -NUDGE], ArrowDown: [0, NUDGE], ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0] }[key]
    if (!step) return false
    const centre = { x: (handle.a.x + handle.b.x) / 2, y: (handle.a.y + handle.b.y) / 2 }
    onDrag(handle.path, { x: centre.x + step[0]!, y: centre.y + step[1]! })
    return true
  }

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}`}
      className="absolute inset-0 size-full touch-none"
      role="group"
      aria-label={label}
    >
      {quads.map((quad, index) => {
        const inner = innerRect(quad)
        const picked = selected === index
        return (
          <g key={index}>
            <polygon
              role="button"
              tabIndex={editable ? 0 : -1}
              aria-label={`第 ${index + 1} 格`}
              aria-pressed={picked}
              points={points(quad)}
              className={cn(
                'cursor-pointer outline-none transition-colors',
                picked
                  ? 'fill-accent/20 stroke-accent'
                  : 'fill-transparent stroke-transparent hover:fill-accent/10 focus-visible:stroke-accent',
              )}
              strokeWidth={10}
              onClick={() => editable && onSelect(index)}
              onKeyDown={(event) => {
                if (editable && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  onSelect(index)
                }
              }}
            />
            <circle
              cx={inner.x + 76}
              cy={inner.y + 76}
              r={56}
              className={cn('pointer-events-none', picked && 'fill-accent')}
              style={picked ? undefined : { fill: PRINT_INK }}
            />
            <text
              x={inner.x + 76}
              y={inner.y + 80}
              textAnchor="middle"
              dominantBaseline="middle"
              className={cn('pointer-events-none text-[64px] font-semibold', picked && 'fill-on-accent')}
              style={picked ? undefined : { fill: PRINT_PAPER }}
            >
              {index + 1}
            </text>
          </g>
        )
      })}
      {handles.map((handle) => (
        <g key={handle.path} className="group">
          <line
            x1={handle.a.x}
            y1={handle.a.y}
            x2={handle.b.x}
            y2={handle.b.y}
            strokeWidth={10}
            strokeLinecap="round"
            className={cn(
              'pointer-events-none stroke-accent transition-opacity',
              dragging === handle.path ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
            )}
          />
          <line
            role="slider"
            tabIndex={0}
            aria-label={handle.axis === 'y' ? '横向格线' : '竖向格线'}
            aria-orientation={handle.axis === 'y' ? 'vertical' : 'horizontal'}
            aria-valuenow={Math.round(handle.axis === 'y' ? (handle.a.y + handle.b.y) / 2 : (handle.a.x + handle.b.x) / 2)}
            x1={handle.a.x}
            y1={handle.a.y}
            x2={handle.b.x}
            y2={handle.b.y}
            strokeWidth={PANEL_GUTTER * 2}
            className={cn('stroke-transparent outline-none', handle.axis === 'y' ? 'cursor-row-resize' : 'cursor-col-resize')}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              setDragging(handle.path)
            }}
            onPointerMove={(event) => {
              if (dragging !== handle.path) return
              const point = toPage(event)
              if (point) onDrag(handle.path, point)
            }}
            onPointerUp={() => setDragging(null)}
            onPointerCancel={() => setDragging(null)}
            onKeyDown={(event) => {
              if (nudge(handle, event.key)) event.preventDefault()
            }}
          />
        </g>
      ))}
    </svg>
  )
}

function Thumbnail({ frames, direction }: { frames: FrameNode; direction: ReadingDirection }): React.JSX.Element {
  return (
    <svg viewBox={`0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}`} className="h-auto w-full" aria-hidden="true">
      {panelQuads(frames, direction, { bleed: true }).map((quad, index) => (
        <polygon key={index} points={points(quad)} className="fill-ink-3" />
      ))}
    </svg>
  )
}

type CountChoice = 'keep' | 'any' | `${number}`

export function PageLayout({
  series,
  page,
  label,
  onChange,
}: {
  series: MangaSeries
  page: MangaPage
  label: string
  onChange: PageChange
}): React.JSX.Element {
  const direction = series.readingDirection
  const [selected, setSelected] = useState<number | null>(null)
  const [styleId, setStyleId] = useState<LayoutStyleId>('standard')
  const [count, setCount] = useState<CountChoice>('keep')
  const [draw, setDraw] = useState<(LayoutDraw & { seed: string }) | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const inUse = panelsInUse(page)
  const pickedItem = picked !== null ? draw?.found[picked] : undefined
  // A layout with fewer panels than have content can be looked at in the tray, never previewed or applied.
  const candidate = pickedItem && pickedItem.panels >= inUse ? pickedItem : undefined
  // The page as it would look with the picked layout, shown until 用这张 or 收起.
  const shown = useMemo(() => (candidate ? (applyFrames(page, candidate.frames, newId) ?? page) : page), [candidate, page])
  const index = selected !== null && selected < page.panels.length ? selected : null
  const blocker = index === null ? undefined : mergeBlocker(page, index)
  const drafts = page.panels.filter((panel) => panel.state === 'draft').length

  const edit = (change: (current: MangaPage) => MangaPage | undefined): void => onChange((current) => change(current) ?? current)

  const runDraw = (): void => {
    const seed = Math.random().toString(36).slice(2, 10)
    const panels = count === 'keep' ? page.panels.length : count === 'any' ? undefined : Number(count)
    const result = drawLayouts({ seed, scope: page.id, style: LAYOUT_STYLES[styleId], panels })
    setDraw({ ...result, seed })
    setPicked(firstUsable(result.found, panelsInUse(page)))
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <PagePreview series={series} page={shown} label={`${label}预览`} />
        <FrameOverlay
          frames={shown.frames}
          direction={direction}
          selected={candidate ? null : index}
          editable={!candidate}
          label={`${label}的分格`}
          onSelect={setSelected}
          onDrag={(path, point) =>
            edit((current) => ({ ...current, frames: dragGutter(current.frames, path, point, direction) ?? current.frames }))
          }
        />
      </div>

      {!candidate ? (
        index !== null ? (
          <div className="flex flex-col gap-2 rounded-lg bg-well p-3" role="group" aria-label={`第 ${index + 1} 格的分格`}>
            <FieldLabel as="h3">第 {index + 1} 格</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="xs"
                disabled={Boolean(splitBlocker(page, index, 'y'))}
                title={splitBlocker(page, index, 'y')}
                onClick={() => edit((current) => splitPanel(current, index, 'y'))}
              >
                <Rows2 className="size-3.5" strokeWidth={1.6} /> 上下拆开
              </Button>
              <Button
                size="xs"
                disabled={Boolean(splitBlocker(page, index, 'x'))}
                title={splitBlocker(page, index, 'x')}
                onClick={() => edit((current) => splitPanel(current, index, 'x'))}
              >
                <Columns2 className="size-3.5" strokeWidth={1.6} /> 左右拆开
              </Button>
              <Button
                size="xs"
                disabled={Boolean(blocker)}
                title={blocker}
                onClick={() => {
                  edit((current) => mergePanel(current, index))
                  setSelected(null)
                }}
              >
                <Merge className="size-3.5" strokeWidth={1.6} /> 合并
              </Button>
            </div>
            <label className="flex items-center justify-between gap-2 text-ui text-ink">
              出血（铺到纸边）
              <Switch
                aria-label={`第 ${index + 1} 格出血`}
                checked={isBleed(page.frames, index)}
                disabled={!touchesEdge(page.frames, index)}
                title={touchesEdge(page.frames, index) ? undefined : '只有贴着页边的格能出血'}
                onCheckedChange={(checked) => edit((current) => ({ ...current, frames: setBleed(current.frames, index, checked) }))}
              />
            </label>
          </div>
        ) : (
          <p className="text-caption text-ink-2">点一格可以拆开、合并或出血；拖动格线调整大小。</p>
        )
      ) : null}

      <div className="flex flex-col gap-2">
        <FieldLabel as="h3">抽分格</FieldLabel>
        <Segmented
          label="分格版式"
          block
          value={styleId}
          onChange={setStyleId}
          options={(Object.keys(LAYOUT_STYLES) as LayoutStyleId[]).map((id) => ({ value: id, label: LAYOUT_STYLE_LABEL[id] }))}
        />
        <div className="flex gap-2">
          <Select
            aria-label="抽几格"
            className="min-w-0 flex-1"
            value={count}
            onValueChange={(value) => setCount(value as CountChoice)}
            options={[
              { value: 'keep', label: `${page.panels.length} 格（和现在一样）` },
              { value: 'any', label: '格数不限' },
              ...Array.from({ length: MAX_FRAME_PANELS }, (_, at) => ({
                value: `${at + 1}`,
                label: `${at + 1} 格`,
                disabled: at + 1 < inUse,
              })),
            ]}
          />
          <Button onClick={runDraw}>
            <Dices className="size-4" strokeWidth={1.6} /> {draw ? '再抽一批' : '抽分格'}
          </Button>
        </div>
        {draw?.problem ? <Notice tone="warn">{draw.problem}</Notice> : null}
        {draw?.found.length ? (
          <>
            <div className="grid grid-cols-4 gap-2" role="group" aria-label="抽到的分格">
              {draw.found.map((item, at) => {
                const fits = item.panels >= inUse
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-label={`候选 ${at + 1}：${item.panels} 格`}
                    aria-pressed={picked === at}
                    disabled={!fits}
                    title={fits ? (item.notes.length ? item.notes.join('、') : undefined) : `放不下已有内容的 ${inUse} 格`}
                    onClick={() => setPicked(at)}
                    className={cn(
                      'rounded-md p-1.5 transition-colors disabled:opacity-40',
                      picked === at ? 'bg-accent-soft' : 'bg-raised enabled:hover:bg-well-strong',
                    )}
                  >
                    <Thumbnail frames={item.frames} direction={direction} />
                  </button>
                )
              })}
            </div>
            <div className="flex gap-2">
              <Button
                tone="primary"
                size="xs"
                disabled={!candidate}
                onClick={() => {
                  if (candidate) edit((current) => applyFrames(current, candidate.frames, newId))
                  setDraw(null)
                  setPicked(null)
                  setSelected(null)
                }}
              >
                <Check className="size-3.5" strokeWidth={1.6} /> 用这张
              </Button>
              <Button
                tone="ghost"
                size="xs"
                onClick={() => {
                  setDraw(null)
                  setPicked(null)
                }}
              >
                收起
              </Button>
            </div>
          </>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Select
          aria-label={`${label}套用版式`}
          className="min-w-0 flex-1"
          value=""
          onValueChange={(templateId) => {
            if (!templateId) return
            edit((current) => applyTemplate(current, templateId))
            setSelected(null)
          }}
          options={[
            { value: '', label: '套用版式…' },
            ...PAGE_TEMPLATES.map((template) => ({
              value: template.id,
              label: `${template.label}（${leafCount(template.frames)} 格）`,
              disabled: leafCount(template.frames) < inUse,
            })),
          ]}
        />
        <Button
          disabled={!drafts}
          title={drafts ? '给还没生成的格随机定景别和角度' : '每一格都已经生成过了'}
          onClick={() => onChange((current) => drawShots(current, Math.random().toString(36).slice(2, 10)))}
        >
          <Camera className="size-4" strokeWidth={1.6} /> 抽镜头
        </Button>
      </div>
    </div>
  )
}
