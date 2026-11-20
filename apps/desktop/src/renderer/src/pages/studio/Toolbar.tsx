import { Brush, Eraser, FlipHorizontal2, Hand, Map as MapIcon, Maximize2, Minus, MousePointer2, Plus, Trash2 } from 'lucide-react'
import { IconButton, cn } from '../../components/ui'
import { BRUSH_MAX, BRUSH_MIN } from './mask'
import type { MaskBrush } from './MaskLayer'
import type { BoardTool } from './RegionLayer'

/** Whether the 遮罩 tool shows, and why it is off. Hidden when the engine cannot inpaint. */
export interface MaskToolState {
  hidden: boolean
  enabled: boolean
  reason?: string
}

const TOOLS: Array<{ id: BoardTool; label: string; key: string; icon: React.ReactNode }> = [
  { id: 'select', label: '选择', key: 'V', icon: <MousePointer2 className="size-4" strokeWidth={1.6} /> },
  { id: 'pan', label: '平移', key: 'H', icon: <Hand className="size-4" strokeWidth={1.6} /> },
]

function ToolButton({ on, className, ...props }: React.ComponentProps<'button'> & { on?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={cn(
        'inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-ui text-ink transition-colors enabled:hover:bg-well disabled:opacity-40',
        on && 'bg-well-strong',
        className,
      )}
      {...props}
    />
  )
}

/** The board's own tools: select, pan, zoom, fit and the minimap. A 画面's tools sit on the card (CardToolbar). */
export function Toolbar({
  tool,
  onTool,
  zoom,
  onZoom,
  onFit,
  minimap,
  onMinimap,
}: {
  tool: BoardTool
  onTool: (tool: BoardTool) => void
  zoom: number
  onZoom: (factor: number) => void
  onFit: () => void
  minimap: boolean
  onMinimap: (on: boolean) => void
}): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label="画布工具"
      data-board-ui
      className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-[10px] bg-raised p-1 shadow-float"
    >
      {TOOLS.map((item) => (
        <ToolButton
          key={item.id}
          on={tool === item.id || (item.id === 'select' && tool === 'mask')}
          aria-label={item.label}
          title={`${item.label}（${item.key}）`}
          onClick={() => onTool(item.id)}
        >
          {item.icon}
        </ToolButton>
      ))}
      <span aria-hidden="true" className="w-2" />
      <IconButton label="缩小" onClick={() => onZoom(1 / 1.25)} className="text-ink">
        <Minus className="size-4" strokeWidth={1.6} />
      </IconButton>
      <button
        type="button"
        onClick={onFit}
        title="适应窗口"
        className="tabular h-8 w-12 rounded-md text-center text-caption text-ink hover:bg-well"
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton label="放大" onClick={() => onZoom(1.25)} className="text-ink">
        <Plus className="size-4" strokeWidth={1.6} />
      </IconButton>
      <IconButton label="适应窗口" title="适应窗口（F）" onClick={onFit} className="text-ink">
        <Maximize2 className="size-4" strokeWidth={1.6} />
      </IconButton>
      <ToolButton on={minimap} aria-label="小地图" title="小地图" onClick={() => onMinimap(!minimap)}>
        <MapIcon className="size-4" strokeWidth={1.6} />
      </ToolButton>
    </div>
  )
}

/** A selected 画面's tool on the card: 遮罩. Boxes are drawn straight on its face; 描图 is in the card's menu. */
export function CardToolbar({
  tool,
  onTool,
  mask,
}: {
  tool: BoardTool
  onTool: (tool: BoardTool) => void
  mask: MaskToolState
}): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label="画面工具"
      data-board-ui
      data-card-tools
      className="flex w-max items-center gap-0.5 whitespace-nowrap rounded-[10px] bg-raised p-1 shadow-float"
    >
      <ToolButton
        on={tool === 'mask'}
        disabled={!mask.enabled}
        aria-label="遮罩"
        title={mask.enabled ? '遮罩（M）' : mask.reason}
        onClick={() => onTool(tool === 'mask' ? 'select' : 'mask')}
      >
        <Brush className="size-4" strokeWidth={1.6} />
        遮罩
      </ToolButton>
    </div>
  )
}

/** Brush settings and commands while the 遮罩 tool is on; floats under the toolbar. */
export function MaskBar({
  brush,
  onBrush,
  onClear,
  onInvert,
  onDone,
}: {
  brush: MaskBrush
  onBrush: (brush: MaskBrush) => void
  onClear: () => void
  onInvert: () => void
  onDone: () => void
}): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label="遮罩工具"
      data-board-ui
      className="absolute left-1/2 top-[64px] z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-[10px] bg-raised p-1 shadow-float"
    >
      <ToolButton
        on={brush.mode === 'paint'}
        aria-label="画笔"
        title="画笔：涂出要重画的部分"
        onClick={() => onBrush({ ...brush, mode: 'paint' })}
      >
        <Brush className="size-4" strokeWidth={1.6} />
      </ToolButton>
      <ToolButton
        on={brush.mode === 'erase'}
        aria-label="橡皮"
        title="橡皮：擦掉涂过的部分"
        onClick={() => onBrush({ ...brush, mode: 'erase' })}
      >
        <Eraser className="size-4" strokeWidth={1.6} />
      </ToolButton>
      <label className="flex h-8 items-center gap-2 px-2 text-caption text-ink-2">
        大小
        <input
          type="range"
          aria-label="笔刷大小"
          min={BRUSH_MIN}
          max={BRUSH_MAX}
          step={4}
          value={brush.size}
          onChange={(event) => onBrush({ ...brush, size: Number(event.target.value) })}
          className="w-24 accent-ink"
        />
        <span className="tabular w-7 text-right text-ink-2">{brush.size}</span>
      </label>
      <ToolButton aria-label="反转" title="反转：涂过的保留，其余重画" onClick={onInvert}>
        <FlipHorizontal2 className="size-4" strokeWidth={1.6} />
        反转
      </ToolButton>
      <ToolButton aria-label="清除" title="清除整个遮罩" onClick={onClear}>
        <Trash2 className="size-4" strokeWidth={1.6} />
        清除
      </ToolButton>
      <span aria-hidden="true" className="w-1" />
      <ToolButton className="bg-well" onClick={onDone}>
        完成
      </ToolButton>
    </div>
  )
}
