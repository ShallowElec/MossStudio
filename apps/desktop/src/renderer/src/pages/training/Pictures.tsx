import { FolderOpen, ImagePlus, LayoutGrid, List, MessageSquareOff, Plus, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { DatasetImage, TrainingDataset } from '@shared/training'
import { cloverUrl } from '../../lib/clover'
import { dimensions } from '../../lib/format'
import { Popover, MenuItem } from '../../components/common/Popover'
import { Button, EmptyState, IconButton, LoadingRow, Pill, Segmented, Spinner, Textarea, cn } from '../../components/ui'
import { filterPictures, problemBadge, problemChips, problemPill, type PictureFilter } from './editorModel'
import { readPreference, writePreference } from './useTraining'

const VIEW_KEY = 'mossstudio.training.pictureView'

type PictureView = 'grid' | 'list'

function Thumb({ image, className }: { image: DatasetImage; className?: string }): React.JSX.Element {
  return (
    <img
      src={cloverUrl(image.path)}
      alt={image.name}
      draggable={false}
      loading="lazy"
      className={cn('aspect-square w-full rounded-md bg-[var(--image-placeholder)] object-cover', className)}
    />
  )
}

function GridTile({ image, onRemove }: { image: DatasetImage; onRemove: () => void }): React.JSX.Element {
  const badge = problemBadge(image)
  const noCaption = image.caption === null || !image.caption.trim()
  return (
    <div className="group relative" data-picture={image.name}>
      <Thumb image={image} />
      {badge ? (
        <span className="absolute bottom-1.5 left-1.5 inline-flex h-5 max-w-[calc(100%-12px)] items-center truncate rounded-full bg-raised px-2 text-micro font-medium text-warn">
          {badge}
        </span>
      ) : null}
      {noCaption ? (
        <span
          className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-raised text-ink-2 group-hover:hidden"
          title="没有描述"
        >
          <MessageSquareOff className="size-3" strokeWidth={1.6} aria-label="没有描述" />
        </span>
      ) : null}
      <IconButton
        label={`移除 ${image.name}`}
        onClick={onRemove}
        className="absolute right-1.5 top-1.5 size-6 rounded-full bg-raised text-ink opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X className="size-3.5" strokeWidth={1.6} />
      </IconButton>
    </div>
  )
}

function CaptionEditor({ image, onSave }: { image: DatasetImage; onSave: (caption: string) => void }): React.JSX.Element {
  const [text, setText] = useState(image.caption ?? '')
  useEffect(() => setText(image.caption ?? ''), [image.caption])
  return (
    <Textarea
      aria-label={`${image.name} 的描述`}
      value={text}
      rows={2}
      placeholder="没有描述"
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text.trim() !== (image.caption ?? '').trim()) onSave(text.trim())
      }}
      className="min-h-[52px] flex-1 resize-none bg-transparent text-ui focus:bg-surface"
    />
  )
}

function ListRow({
  image,
  onRemove,
  onCaption,
}: {
  image: DatasetImage
  onRemove: () => void
  onCaption: (caption: string) => void
}): React.JSX.Element {
  const issue = problemPill(image)
  return (
    <div className="flex items-center gap-3.5 rounded-lg px-2.5 py-2 hover:bg-well" data-picture={image.name}>
      <div className="w-[60px] shrink-0">
        <Thumb image={image} />
      </div>
      <CaptionEditor image={image} onSave={onCaption} />
      <span className="tabular w-24 shrink-0 text-right font-mono text-caption text-ink-2">{dimensions(image.width, image.height)}</span>
      <span className="flex w-28 shrink-0 justify-end">{issue ? <Pill tone="warn">{issue}</Pill> : null}</span>
      <IconButton label={`移除 ${image.name}`} onClick={onRemove}>
        <X className="size-4" strokeWidth={1.6} />
      </IconButton>
    </div>
  )
}

/**
 * The pictures of a draft: problems as chips that filter and as badges on the
 * pictures, a grid to look at or a list to describe each one.
 */
export function Pictures({
  dataset,
  captioning,
  notice,
  onAddFiles,
  onAddFolder,
  onRemove,
  onCaption,
  onAutoCaption,
}: {
  dataset: TrainingDataset | null
  captioning: boolean
  notice: React.ReactNode
  onAddFiles: () => void
  onAddFolder: () => void
  onRemove: (name: string) => void
  onCaption: (name: string, caption: string) => void
  onAutoCaption: () => void
}): React.JSX.Element {
  const [filter, setFilter] = useState<PictureFilter>('all')
  const [view, setView] = useState<PictureView>(() => (readPreference(VIEW_KEY) === 'list' ? 'list' : 'grid'))
  const chips = useMemo(() => (dataset ? problemChips(dataset) : []), [dataset])
  // A filter whose problem is gone shows everything again.
  const active = chips.some((chip) => chip.filter === filter) ? filter : 'all'
  const shown = useMemo(() => (dataset ? filterPictures(dataset.images, active) : []), [dataset, active])

  const addMenu = (
    <Popover
      align="end"
      label="添加图片"
      trigger={({ toggle, open: _open, ...aria }) => (
        <Button {...aria} onClick={toggle}>
          <ImagePlus className="size-4" strokeWidth={1.6} aria-hidden="true" />
          添加图片
        </Button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            onSelect={() => {
              close()
              onAddFiles()
            }}
          >
            选择图片…
          </MenuItem>
          <MenuItem
            onSelect={() => {
              close()
              onAddFolder()
            }}
          >
            选择文件夹…
          </MenuItem>
        </>
      )}
    </Popover>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-board px-7 py-5" data-pictures>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1.5 text-control font-semibold text-ink">{dataset ? `${dataset.counts.total} 张图片` : '图片'}</span>
        {chips.map((chip) => (
          <button
            key={chip.filter}
            type="button"
            aria-pressed={active === chip.filter}
            data-chip={chip.filter}
            onClick={() => setFilter(active === chip.filter ? 'all' : chip.filter)}
            className="rounded-md"
          >
            <Pill tone={active === chip.filter ? 'accent' : chip.tone}>
              {chip.filter === 'noCaption' ? <MessageSquareOff className="size-3" strokeWidth={1.6} aria-hidden="true" /> : null}
              {chip.label}
            </Pill>
          </button>
        ))}
        <span className="flex-1" />
        {dataset?.images.length ? (
          <Button onClick={onAutoCaption} disabled={captioning}>
            {captioning ? <Spinner /> : <Sparkles className="size-4" strokeWidth={1.6} aria-hidden="true" />}
            自动写描述
          </Button>
        ) : null}
        {addMenu}
        <Segmented<PictureView>
          label="图片显示方式"
          value={view}
          onChange={(next) => {
            setView(next)
            writePreference(VIEW_KEY, next)
          }}
          options={[
            { value: 'grid', label: <LayoutGrid className="size-4" strokeWidth={1.6} aria-label="网格" />, hint: '网格' },
            { value: 'list', label: <List className="size-4" strokeWidth={1.6} aria-label="列表" />, hint: '列表' },
          ]}
        />
      </div>
      {notice}
      {!dataset ? (
        <LoadingRow />
      ) : dataset.images.length === 0 ? (
        <EmptyState
          icon={<FolderOpen className="size-8" strokeWidth={1.6} />}
          title="把图片或文件夹拖到这里"
          action={
            <div className="flex gap-2">
              <Button onClick={onAddFolder}>
                <Plus className="size-4" strokeWidth={1.6} aria-hidden="true" />
                选择文件夹
              </Button>
              <Button onClick={onAddFiles}>选择图片</Button>
            </div>
          }
          className="flex-1"
        />
      ) : view === 'grid' ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5">
          {shown.map((image) => (
            <GridTile key={image.name} image={image} onRemove={() => onRemove(image.name)} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {shown.map((image) => (
            <ListRow
              key={image.name}
              image={image}
              onRemove={() => onRemove(image.name)}
              onCaption={(caption) => onCaption(image.name, caption)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
