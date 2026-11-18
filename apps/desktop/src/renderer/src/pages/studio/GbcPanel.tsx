import { ImagePlus, Square, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { GbcLanguage, GbcPicture } from '@shared/gbc'
import type { ProjectCanvas } from '@shared/types'
import { Button, FieldLabel, Segmented, Select, Spinner, Textarea, useToast } from '../../components/ui'
import { Notice } from '../../components/common/Notice'
import { call } from '../../lib/api'
import { cloverUrl } from '../../lib/clover'
import { useGbcJob, useGbcState } from '../../lib/gbc'
import { useApp } from '../../store'
import { GalleryPicker } from './GalleryPicker'
import { linkSourceImage } from './links'
import { givesPicture, pictureLink } from './runs'

interface Source {
  path: string
  title: string
  size?: { width: number; height: number }
}

/**
 * 解析: the top bar's way from any picture to a prompt and a box layout. It
 * reads with KohakuGBC (设置 › 功能 holds the install and the versions), shows
 * the caption and the boxes, and either copies the prompt or makes a 画面 out
 * of them. The card menu 拆成区域 is the same run with a board picture filled in.
 */
export function GbcPanel({
  canvases,
  onMakeCanvas,
  onUseAsReference,
  onClose,
}: {
  canvases: readonly ProjectCanvas[]
  onMakeCanvas: (picture: GbcPicture, source: Source) => void
  /** Links the picture into the selected 画面 as a vision reference; absent when none is selected. */
  onUseAsReference?: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const settings = useApp((state) => state.settings)
  const toast = useToast()
  const enabled = Boolean(settings?.gbcEnabled)
  const gbc = useGbcState(enabled, settings?.gbcVersionId ?? null)
  const job = useGbcJob()
  const [source, setSource] = useState<Source | null>(null)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [detector, setDetector] = useState<'owlv2' | 'sam3'>('owlv2')
  const [language, setLanguage] = useState<GbcLanguage>('auto')
  const [caption, setCaption] = useState('')
  const [installing, setInstalling] = useState(false)

  // Settings arrive after the first render; the defaults follow them once.
  useEffect(() => {
    if (!settings) return
    setDetector(settings.gbcDetector)
    setLanguage(settings.gbcLanguage)
  }, [settings])

  useEffect(() => {
    if (!providerId && gbc.providers.length) {
      const chosen =
        settings?.gbcProviderId && gbc.providers.some((item) => item.id === settings.gbcProviderId)
          ? settings.gbcProviderId
          : gbc.providers[0]!.id
      setProviderId(chosen)
    }
  }, [gbc.providers, providerId, settings?.gbcProviderId])

  useEffect(() => {
    const picture = job.job?.pictures[0]?.picture
    if (picture) setCaption(picture.summary)
  }, [job.job?.pictures])

  const boardPictures = useMemo(
    () =>
      canvases.flatMap((canvas) => {
        if (!givesPicture(canvas, canvases)) return []
        const path = linkSourceImage(pictureLink(canvases, { canvasId: canvas.id }), canvases)
        return path ? [{ id: canvas.id, title: canvas.title, path }] : []
      }),
    [canvases],
  )

  const picture = job.job?.pictures[0]?.picture ?? null
  const running = job.busy
  const canRun = Boolean(source) && Boolean(providerId) && !running && !gbc.blocker && gbc.status?.available !== false

  function start(fresh = false): void {
    if (!source || !providerId) return
    setCaption('')
    void job
      .run({ path: source.path, providerId, detector, language, destination: 'studio', fresh })
      .catch((error: unknown) => toast.push(error instanceof Error ? error.message : String(error), 'error'))
  }

  async function install(): Promise<void> {
    setInstalling(true)
    try {
      await call(Ipc.gbcSetup)
      toast.push('安装完成', 'success')
      await gbc.refresh(true)
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setInstalling(false)
    }
  }

  function close(): void {
    onClose()
  }

  return (
    <div data-gbc-panel className="flex h-full min-h-0 flex-col p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-ui text-ink">解析</h2>
        <Button tone="ghost" size="xs" aria-label="关闭解析" onClick={close}>
          <X className="size-3.5" aria-hidden="true" strokeWidth={1.8} />
        </Button>
      </div>
      <p className="mt-1 text-caption text-ink-2">从一张图读出提示词和区域框，可以直接做成画面。</p>

      {!enabled ? (
        <Notice className="mt-3">先在 设置 › 功能 里打开「看图拆区域」。</Notice>
      ) : gbc.blocker ? (
        <div className="mt-3 flex flex-col gap-2">
          <Notice tone="warn">{gbc.blocker}</Notice>
          {gbc.status && !gbc.status.available ? (
            <>
              <ul className="flex flex-col gap-1 text-caption text-ink-2">
                {gbc.status.checks.map((check) => (
                  <li key={check.id}>
                    {check.ok ? '✓' : '·'} {check.label}：{check.detail}
                  </li>
                ))}
              </ul>
              <Button tone="primary" size="sm" disabled={installing} onClick={() => void install()}>
                {installing ? '安装中…' : '安装 KohakuGBC'}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <section className="flex flex-col gap-2">
          <FieldLabel>图片</FieldLabel>
          <div
            onDragOver={(event) => {
              if ([...event.dataTransfer.types].includes('Files')) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
              }
            }}
            onDrop={(event) => {
              const file = event.dataTransfer.files[0]
              if (!file) return
              event.preventDefault()
              const path = window.clover.pathForFile?.(file) ?? ''
              if (path) setSource({ path, title: file.name.replace(/\.[^.]+$/, '') })
            }}
            className="flex flex-col items-center gap-2 rounded-lg bg-well px-3 py-5 text-caption text-ink-2"
          >
            <ImagePlus className="size-5" aria-hidden="true" strokeWidth={1.6} />
            把图片拖到这里
            <div className="flex gap-2">
              <Button size="xs" onClick={() => setGalleryOpen(true)}>
                从作品选择
              </Button>
              {boardPictures.length ? (
                <Select
                  aria-label="从画板选择"
                  value=""
                  onChange={(event) => {
                    const picked = boardPictures.find((item) => item.id === event.target.value)
                    if (picked) setSource({ path: picked.path, title: picked.title })
                  }}
                  className="h-7"
                >
                  <option value="">从画板选择…</option>
                  {boardPictures.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>
          </div>
          {source ? (
            <div className="flex flex-col gap-2">
              <div className="relative overflow-hidden rounded-lg bg-well">
                <img
                  src={cloverUrl(source.path)}
                  alt={source.title}
                  className="block w-full"
                  onLoad={(event) => {
                    const image = event.currentTarget
                    if (image.naturalWidth) {
                      setSource((current) =>
                        current ? { ...current, size: { width: image.naturalWidth, height: image.naturalHeight } } : current,
                      )
                    }
                  }}
                />
                {(picture?.regions ?? []).map((region, index) => (
                  <span
                    key={`${region.caption}-${index}`}
                    title={region.caption}
                    className="pointer-events-none absolute rounded-[3px] outline-2 outline-accent/80"
                    style={{
                      left: `${region.bbox.x * 100}%`,
                      top: `${region.bbox.y * 100}%`,
                      width: `${region.bbox.w * 100}%`,
                      height: `${region.bbox.h * 100}%`,
                    }}
                  />
                ))}
              </div>
              <p className="text-caption text-ink-2">{source.title}</p>
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-2">
          <FieldLabel htmlFor="gbc-provider">看图的模型</FieldLabel>
          <Select
            id="gbc-provider"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
            disabled={!gbc.providers.length}
          >
            {gbc.providers.length ? null : <option value="">先在 助手 里加一个模型</option>}
            {gbc.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </Select>
          <div className="flex gap-2">
            <Select aria-label="找物体的方式" value={detector} onChange={(event) => setDetector(event.target.value as 'owlv2' | 'sam3')}>
              <option value="owlv2">OWLv2</option>
              <option value="sam3">SAM 3</option>
            </Select>
            <Segmented<GbcLanguage>
              label="文字语言"
              value={language}
              onChange={setLanguage}
              options={[
                { value: 'auto', label: '自动' },
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'English' },
              ]}
            />
          </div>
        </section>

        <div className="flex items-center gap-2">
          {running ? (
            <>
              <Spinner className="size-4" />
              <span className="text-caption text-ink-2">
                正在读图{job.job && job.job.total > 1 ? ` · ${job.job.done} / ${job.job.total}` : ''}
              </span>
              <Button tone="ghost" size="xs" onClick={() => job.cancel()}>
                <Square className="size-3" aria-hidden="true" strokeWidth={2} />
                停止
              </Button>
            </>
          ) : (
            <Button tone="primary" size="sm" data-gbc-run disabled={!canRun} onClick={() => start()}>
              解析
            </Button>
          )}
        </div>

        {job.job?.phase === 'failed' ? <Notice tone="danger">{job.job.error ?? '解析失败'}</Notice> : null}
        {job.job?.warnings.length ? <Notice tone="warn">{job.job.warnings[0]}</Notice> : null}

        {picture ? (
          <section className="flex flex-col gap-2">
            <FieldLabel htmlFor="gbc-caption">提示词</FieldLabel>
            <Textarea id="gbc-caption" value={caption} onChange={(event) => setCaption(event.target.value)} className="h-24 resize-none" />
            <div className="flex flex-wrap gap-2">
              <Button
                tone="primary"
                size="sm"
                onClick={() => {
                  if (!source) return
                  onMakeCanvas({ ...picture, summary: caption.trim() || picture.summary, short: picture.short }, source)
                  toast.push('已做成画面', 'success')
                }}
              >
                变成画面
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(caption).then(
                    () => toast.push('提示词已复制', 'success'),
                    () => toast.push('复制失败', 'error'),
                  )
                }}
              >
                复制提示词
              </Button>
              {onUseAsReference && source ? (
                <Button size="sm" onClick={() => onUseAsReference(source.path)}>
                  作为参考图
                </Button>
              ) : null}
              <Button size="sm" tone="ghost" disabled={running || !source} onClick={() => start(true)}>
                重新读
              </Button>
            </div>
            <p className="text-caption text-ink-2">{picture.regions.length} 个区域</p>
          </section>
        ) : null}
      </div>

      <GalleryPicker
        open={galleryOpen}
        title="选择图片"
        onClose={() => setGalleryOpen(false)}
        onPick={(path) => {
          setGalleryOpen(false)
          setSource({
            path,
            title:
              path
                .split(/[\\/]/)
                .pop()
                ?.replace(/\.[^.]+$/, '') ?? '',
          })
        }}
      />
    </div>
  )
}
