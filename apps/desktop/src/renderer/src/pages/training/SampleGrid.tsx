import { PreviewButton } from '../../components/common/ImageLightbox'
import { cloverUrl } from '../../lib/clover'
import { cn } from '../../components/ui'
import type { SampleColumn } from './sampleGridModel'

/**
 * Sample pictures as a grid: one row per sample description, one column per
 * step, 训练前 first. Steps still to come are plain tone cells. When `onChoose`
 * is given, a column with a checkpoint can be clicked (header or picture) to
 * save that step; the chosen one is outlined in the accent.
 */
export function SampleGrid({
  prompts,
  columns,
  current,
  onChoose,
  busyStep,
}: {
  prompts: string[]
  columns: SampleColumn[]
  /** While running: the newest drawn column, its header in the accent. */
  current?: number | null
  onChoose?: (step: number) => void
  /** A step being saved right now. */
  busyStep?: number | null
}): React.JSX.Element {
  const choose = (column: SampleColumn): (() => void) | undefined =>
    onChoose && column.choosable && busyStep == null ? () => onChoose(column.step) : undefined

  // Every column fits the width (up to 128 px a cell), so the whole run is in view at once.
  const grid = { gridTemplateColumns: `repeat(${columns.length}, minmax(0, 128px))` }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-board px-7 py-6" data-sample-grid>
      <div className="flex flex-col gap-5">
        <div className="grid gap-2.5" style={grid}>
          {columns.map((column) => {
            const pick = choose(column)
            const label = column.chosen ? `${column.label} · 已选` : busyStep === column.step ? `${column.label} · 正在保存…` : column.label
            return pick ? (
              <button
                key={column.step}
                type="button"
                data-sample-column={column.step}
                aria-pressed={column.chosen}
                onClick={pick}
                className={cn(
                  'tabular min-h-6 min-w-0 rounded-md px-1 text-caption leading-tight transition-colors',
                  column.chosen ? 'bg-accent-soft font-semibold text-ink' : 'text-ink-2 hover:bg-well hover:text-ink',
                )}
              >
                {label}
              </button>
            ) : (
              <span
                key={column.step}
                data-sample-column={column.step}
                className={cn(
                  'tabular flex min-h-6 min-w-0 items-center justify-center rounded-md px-1 text-center text-caption leading-tight',
                  column.chosen
                    ? 'bg-accent-soft font-semibold text-ink'
                    : current === column.step
                      ? 'font-semibold text-accent'
                      : 'text-ink-2',
                )}
              >
                {label}
              </span>
            )
          })}
        </div>
        {prompts.map((prompt, row) => (
          <div key={`${row}-${prompt}`} className="flex flex-col gap-2" data-sample-row={row}>
            <p className="max-w-[60ch] text-ui text-ink">{prompt}</p>
            <div className="grid gap-2.5" style={grid}>
              {columns.map((column) => {
                const image = column.images[row] ?? null
                const pick = choose(column)
                const cell = cn(
                  'aspect-square min-w-0 overflow-hidden rounded-md',
                  column.chosen && 'outline-2 outline-offset-2 outline-accent outline',
                )
                if (column.pending || !image)
                  return (
                    <span
                      key={column.step}
                      className={cn(cell, 'flex items-center justify-center bg-well p-1 text-center text-micro text-ink-2')}
                      data-sample-pending={column.pending ? column.step : undefined}
                    >
                      {column.pending ? column.pendingText : ''}
                    </span>
                  )
                const picture = <img src={cloverUrl(image)} alt="" draggable={false} className="size-full object-cover" />
                return (
                  <div key={column.step} className={cn(cell, 'group relative bg-[var(--image-placeholder)]')}>
                    {pick ? (
                      <button
                        type="button"
                        aria-label={`${prompt}，${column.label}`}
                        onClick={pick}
                        className="size-full transition-opacity hover:opacity-90"
                      >
                        {picture}
                      </button>
                    ) : null}
                    <PreviewButton
                      path={image}
                      title={`${prompt}，${column.label}`}
                      className={
                        pick
                          ? 'absolute right-1 top-1 size-auto rounded-md bg-raised px-1.5 text-caption text-ink opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                          : undefined
                      }
                    >
                      {pick ? '放大' : picture}
                    </PreviewButton>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
