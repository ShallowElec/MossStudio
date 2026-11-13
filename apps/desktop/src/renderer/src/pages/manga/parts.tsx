import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ADAPTER_STRENGTH_MAX, ADAPTER_STRENGTH_STEP, adapterStatuses, clampAdapterStrength, isSelectableAdapter } from '@shared/adapters'
import { Ipc } from '@shared/channels'
import type { AiProviderInfo } from '@shared/ai'
import { PAGE_HEIGHT, PAGE_WIDTH } from '@shared/manga/layouts'
import type { MemoryRequest } from '@shared/manga/memory'
import type { MangaAdapter, MangaPage, MangaSeries } from '@shared/manga/model'
import { call } from '../../lib/api'
import { strength } from '../../lib/format'
import { FieldLabel, IconButton, Select, cn } from '../../components/ui'
import { useApp } from '../../store'
import { SliderField } from '../studio/InputControls'
import { drawPage, loadPagePictures, type PictureCache } from './render'

/** The LoRA rows of the 画风 or a character: each with its weight, plus a picker of installed ones. */
export function AdapterEditor({
  adapters,
  onChange,
  label = 'LoRA',
}: {
  adapters: MangaAdapter[]
  onChange: (next: MangaAdapter[]) => void
  label?: string
}): React.JSX.Element {
  const catalog = useApp((state) => state.catalog)
  const rows = adapterStatuses(adapters, catalog?.adapters)
  const choices = (catalog?.adapters ?? []).filter((entry) => isSelectableAdapter(entry) && !adapters.some((item) => item.id === entry.id))
  return (
    <div className="flex flex-col gap-2">
      <FieldLabel as="h3">{label}</FieldLabel>
      {rows.map(({ adapter, name, installed }) => {
        const row = { id: adapter.id, strength: adapter.strength, name, installed }
        return (
          <div key={row.id} className="flex items-center gap-2 rounded-lg bg-well px-3 py-1.5">
            <span className={cn('min-w-0 flex-1 truncate text-ui', row.installed ? 'text-ink' : 'text-danger')}>
              {row.name}
              {row.installed ? '' : '（找不到了）'}
            </span>
            <SliderField
              label="权重"
              ariaLabel={`${row.name} 的权重`}
              className="w-56"
              value={row.strength}
              min={0}
              max={ADAPTER_STRENGTH_MAX}
              step={ADAPTER_STRENGTH_STEP}
              format={(value) => strength(value, 'weight')}
              onChange={(value) =>
                onChange(adapters.map((item) => (item.id === row.id ? { ...item, strength: clampAdapterStrength(value) } : item)))
              }
            />
            <IconButton
              label={`移除 ${row.name}`}
              className="size-7"
              onClick={() => onChange(adapters.filter((item) => item.id !== row.id))}
            >
              <X className="size-3.5" strokeWidth={1.6} />
            </IconButton>
          </div>
        )
      })}
      {choices.length ? (
        <Select
          aria-label={`添加${label}`}
          value=""
          onValueChange={(id) => id && onChange([...adapters, { id, strength: 1 }])}
          options={[{ value: '', label: `添加${label}…` }, ...choices.map((entry) => ({ value: entry.id, label: entry.name }))]}
        />
      ) : (
        <p className="text-caption text-ink-2">
          {catalog?.adapters?.length ? '已安装的 LoRA 都加上了' : '模型库里还没有 LoRA，可以在模型页添加'}
        </p>
      )}
    </div>
  )
}

/** A finished page drawn small, as it will be exported. */
export function PagePreview({
  series,
  page,
  className,
  label,
}: {
  series: Pick<MangaSeries, 'readingDirection'>
  page: MangaPage
  className?: string
  label: string
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const cache = useMemo<PictureCache>(() => new Map(), [])
  useEffect(() => {
    let alive = true
    void loadPagePictures(page, cache).then(() => {
      const ctx = canvas.current?.getContext('2d')
      if (alive && ctx) drawPage(ctx, series, page, cache)
    })
    return () => {
      alive = false
    }
  }, [series, page, cache])
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={label}
      data-manga-page={page.id}
      width={PAGE_WIDTH}
      height={PAGE_HEIGHT}
      className={cn('h-auto w-full rounded-md bg-raised', className)}
    />
  )
}

/** The language models connected in the assistant (连接设置). */
export function useProviders(): { providers: AiProviderInfo[]; loaded: boolean } {
  const [providers, setProviders] = useState<AiProviderInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    call<AiProviderInfo[]>(Ipc.aiProvidersList)
      .then(setProviders)
      .catch(() => setProviders([]))
      .finally(() => setLoaded(true))
  }, [])
  return { providers, loaded }
}

/** One storyboard or memory request to the series' language model. */
export function askModel(series: Pick<MangaSeries, 'providerId'>, request: MemoryRequest, providers: AiProviderInfo[]): Promise<string> {
  const providerId = providers.some((item) => item.id === series.providerId) ? series.providerId : undefined
  return call<string>(Ipc.aiComplete, { providerId, system: request.system, prompt: request.user })
}
