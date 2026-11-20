import { cn } from '../../components/ui'
import { MenuItem, Popover } from '../../components/common/Popover'
import type { CardJobView } from './jobStatus'
import type { StripItem } from './runs'
import { OutputImage } from './OutputImage'

/** What a thumbnail without a picture says: the run is still going, failed or was stopped. */
function placeholder(view: CardJobView | undefined): string {
  if (!view || view.active) return '…'
  if (view.state === 'failed') return '失败'
  if (view.state === 'canceled' || view.state === 'lost') return '停止'
  return '…'
}

function Thumb({
  item,
  view,
  on,
  marked,
  onShow,
  onOpen,
  onPointerDown,
}: {
  item: StripItem
  view: CardJobView | undefined
  on: boolean
  /** Ring the shown thumbnail (only when there is more than one). */
  marked: boolean
  onShow: () => void
  onOpen: () => void
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-strip-item={`${item.runId}/${item.output}`}
      aria-label={`第 ${item.number} 张`}
      aria-pressed={on}
      title={item.path ? '点一下放到画面上，双击放大看；拖到画板上单独放' : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={(event) => {
        event.stopPropagation()
        if (item.path) onOpen()
      }}
      onClick={(event) => {
        event.stopPropagation()
        // A pointer press shows it on pointer-up (see Board), unless it was dragged out; keys click here.
        if (event.detail === 0 || !onPointerDown) onShow()
      }}
      className={cn(
        'tabular flex size-8 shrink-0 touch-none items-center justify-center overflow-hidden rounded-[4px] bg-well-strong text-micro text-ink',
        on && marked && 'ring-2 ring-accent ring-offset-2 ring-offset-board',
      )}
    >
      {item.path ? <OutputImage path={item.path} alt="" compact /> : placeholder(view)}
    </button>
  )
}

/** A run still waiting its turn: a quiet tile that breathes; its menu calls it off. */
function QueuedThumb({ tile, number, onCancel }: { tile: QueuedTile; number: number; onCancel: () => void }): React.JSX.Element {
  return (
    <Popover
      align="start"
      label={`第 ${number} 张`}
      className="w-[148px]"
      trigger={(menu) => (
        <button
          type="button"
          data-strip-queued={tile.runId}
          aria-label={`第 ${number} 张，排队中`}
          aria-expanded={menu['aria-expanded']}
          aria-haspopup={menu['aria-haspopup']}
          aria-controls={menu['aria-controls']}
          onClick={(event) => {
            event.stopPropagation()
            menu.toggle()
          }}
          className="studio-card-running size-8 shrink-0 rounded-[4px] bg-well"
        />
      )}
    >
      {(close) => (
        <MenuItem
          disabled={!tile.cancellable}
          onSelect={() => {
            close()
            onCancel()
          }}
        >
          取消这一张
        </MenuItem>
      )}
    </Popover>
  )
}

/** A run of the strip that waits behind the one being drawn. */
export interface QueuedTile {
  runId: string
  /** It has reached the engine (has a job), so it can be called off. */
  cancellable: boolean
}

/**
 * A 画面's filmstrip: every picture it has made, newest on the right, then
 * one placeholder per run still waiting its turn. Click a picture to show it
 * on the face (that is the picture its wires carry); the older ones that do
 * not fit sit behind "+N".
 */
export function Filmstrip({
  items,
  queued = [],
  shown,
  views,
  max,
  onShow,
  onOpen,
  onPointerDown,
  onCancelQueued,
}: {
  items: readonly StripItem[]
  queued?: readonly QueuedTile[]
  shown: number
  views: ReadonlyMap<string, CardJobView>
  /** How many thumbnails fit beside the buttons. */
  max: number
  onShow: (index: number) => void
  /** Open the viewer at this picture. */
  onOpen: (index: number) => void
  onPointerDown?: (index: number, event: React.PointerEvent<HTMLButtonElement>) => void
  onCancelQueued?: (runId: string) => void
}): React.JSX.Element {
  // Placeholders are the newest entries: what does not fit is the oldest pictures first.
  const total = items.length + queued.length
  const hidden = Math.max(0, total - max)
  const marked = items.length > 1
  const placeholder = (tile: QueuedTile, at: number, close?: () => void): React.JSX.Element => (
    <QueuedThumb
      key={tile.runId}
      tile={tile}
      number={items.length + at + 1}
      onCancel={() => {
        close?.()
        onCancelQueued?.(tile.runId)
      }}
    />
  )
  return (
    <div data-filmstrip className="flex min-w-0 items-center gap-1.5">
      {hidden ? (
        <Popover
          align="start"
          label="全部图片"
          className="w-[232px]"
          trigger={(menu) => (
            <button
              type="button"
              aria-expanded={menu['aria-expanded']}
              aria-haspopup={menu['aria-haspopup']}
              aria-controls={menu['aria-controls']}
              title="看全部图片"
              onClick={(event) => {
                event.stopPropagation()
                menu.toggle()
              }}
              className={cn(
                'tabular h-8 shrink-0 rounded-[4px] px-1.5 text-caption transition-colors',
                shown < hidden ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-well hover:text-ink',
              )}
            >
              +{hidden}
            </button>
          )}
        >
          {(close) => (
            <div className="grid grid-cols-5 gap-1.5 p-1.5">
              {items.map((item, index) => (
                <Thumb
                  key={`${item.runId}/${item.output}`}
                  item={item}
                  view={views.get(item.runId)}
                  on={index === shown}
                  marked={marked}
                  onShow={() => {
                    onShow(index)
                    close()
                  }}
                  onOpen={() => {
                    close()
                    onOpen(index)
                  }}
                />
              ))}
              {queued.map((tile, at) => placeholder(tile, at, close))}
            </div>
          )}
        </Popover>
      ) : null}
      {items.slice(hidden).map((item, offset) => {
        const index = hidden + offset
        return (
          <Thumb
            key={`${item.runId}/${item.output}`}
            item={item}
            view={views.get(item.runId)}
            on={index === shown}
            marked={marked}
            onShow={() => onShow(index)}
            onOpen={() => onOpen(index)}
            onPointerDown={onPointerDown ? (event) => onPointerDown(index, event) : undefined}
          />
        )
      })}
      {queued.map((tile, at) => (items.length + at >= hidden ? placeholder(tile, at) : null))}
    </div>
  )
}
