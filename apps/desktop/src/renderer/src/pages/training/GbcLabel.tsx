import { useEffect, useMemo, useState } from 'react'
import { trainingCaption, type GbcJobPicture } from '@shared/gbc'
import type { DatasetImage } from '@shared/training'
import { Button, ConfirmDialog, Modal, Segmented, Spinner, Textarea, useToast } from '../../components/ui'
import { Notice } from '../../components/common/Notice'
import { cloverUrl } from '../../lib/clover'
import { useGbcJob, useGbcState } from '../../lib/gbc'
import { useApp } from '../../store'

/**
 * GBC 打标: read a dataset with KohakuGBC and review the captions it suggests.
 * A suggestion is only written when the person accepts it; a hand-written
 * description is shown as 替换, never overwritten in passing.
 */
export function GbcLabel({
  trainingId,
  images,
  onLabel,
}: {
  trainingId: string
  images: readonly DatasetImage[]
  onLabel: (name: string, caption: string) => void
}): React.JSX.Element {
  const settings = useApp((state) => state.settings)
  const toast = useToast()
  const enabled = Boolean(settings?.gbcEnabled)
  const gbc = useGbcState(enabled, settings?.gbcVersionId ?? null)
  const job = useGbcJob()
  const [scope, setScope] = useState<'noCaption' | 'all'>('noCaption')
  const [confirming, setConfirming] = useState(false)
  const [queue, setQueue] = useState<GbcJobPicture[] | null>(null)
  const [index, setIndex] = useState(0)
  const [draft, setDraft] = useState('')
  const [done, setDone] = useState({ written: 0, skipped: 0 })

  const providerId = useMemo(() => {
    const chosen = settings?.gbcProviderId
    return chosen && gbc.providers.some((provider) => provider.id === chosen) ? chosen : (gbc.providers[0]?.id ?? '')
  }, [gbc.providers, settings?.gbcProviderId])

  const candidates = useMemo(() => images.filter((image) => (scope === 'all' ? true : !image.caption?.trim())), [images, scope])

  // A finished job becomes the review queue, one picture at a time.
  useEffect(() => {
    if (job.job?.phase !== 'done' || queue || !job.job.pictures.length) return
    const byPath = new Map(images.map((image) => [image.path, image]))
    const found = job.job.pictures.filter((picture) => byPath.has(picture.path))
    if (!found.length) {
      toast.push('这次没有读到可写入的描述', 'error')
      return
    }
    setQueue(found)
    setIndex(0)
    setDone({ written: 0, skipped: 0 })
  }, [job.job?.phase, job.job?.pictures, images, queue, toast])

  useEffect(() => {
    const current = queue?.[index]
    if (current) setDraft(trainingCaption(current.picture))
  }, [queue, index])

  const current = queue?.[index] ?? null
  const image = current ? images.find((item) => item.path === current.path) : undefined
  const running = job.busy

  function start(): void {
    if (!providerId) {
      toast.push('先给助手加一个能看图的模型', 'error')
      return
    }
    setConfirming(false)
    void job
      .run({
        files: candidates.map((item) => item.path),
        providerId,
        detector: settings?.gbcDetector ?? 'owlv2',
        language: settings?.gbcLanguage ?? 'auto',
        destination: 'training',
        trainingId,
      })
      .catch((error: unknown) => toast.push(error instanceof Error ? error.message : String(error), 'error'))
  }

  function next(accepted: boolean): void {
    if (!current || !image) return
    const caption = draft.trim()
    if (accepted && caption) {
      onLabel(image.name, caption)
      setDone((value) => ({ ...value, written: value.written + 1 }))
    } else {
      setDone((value) => ({ ...value, skipped: value.skipped + 1 }))
    }
    if (index + 1 < (queue?.length ?? 0)) {
      setIndex((value) => value + 1)
      return
    }
    setQueue(null)
    job.clear()
  }

  function acceptAll(): void {
    if (!queue) return
    let written = 0
    for (const entry of queue.slice(index)) {
      const match = images.find((item) => item.path === entry.path)
      const caption = trainingCaption(entry.picture)
      if (match && caption.trim()) {
        onLabel(match.name, caption.trim())
        written += 1
      }
    }
    setDone((value) => ({ written: value.written + written, skipped: value.skipped + (queue.length - index - written) }))
    setQueue(null)
    job.clear()
  }

  if (!enabled) return <></>

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Segmented<'noCaption' | 'all'>
          label="打标范围"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'noCaption', label: '没描述' },
            { value: 'all', label: '全部' },
          ]}
        />
        <Button
          onClick={() => (candidates.length > 10 ? setConfirming(true) : start())}
          disabled={running || !candidates.length || Boolean(gbc.blocker)}
          title={gbc.blocker ?? undefined}
        >
          {running ? <Spinner /> : null}
          {running ? '读图中…' : `GBC 打标 (${candidates.length})`}
        </Button>
        {running ? (
          <Button tone="ghost" onClick={() => job.cancel()}>
            停止
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        title={`用 GBC 打标 ${candidates.length} 张？`}
        description="每张图要调用十几次看图模型，会花几分钟和对应的 API 费用。只有你点接受的描述才会写入。"
        confirmLabel="开始打标"
        destructive={false}
        onClose={() => setConfirming(false)}
        onConfirm={start}
      />

      {job.job?.phase === 'failed' ? <Notice tone="danger">{job.job.error ?? '打标失败'}</Notice> : null}
      {job.job?.warnings.length ? <Notice tone="warn">{job.job.warnings[0]}</Notice> : null}

      <Modal open={Boolean(current)} onClose={() => next(false)} title="检查 GBC 写的描述">
        {current && image ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between text-caption text-ink-2">
              <span>
                第 {index + 1} / {queue?.length ?? 0} 张 · {image.name}
              </span>
              <span>
                已接受 {done.written} · 跳过 {done.skipped}
              </span>
            </div>
            <div className="max-h-[38vh] overflow-hidden rounded-lg bg-well">
              <img src={cloverUrl(current.path)} alt={image.name} className="block max-h-[38vh] w-full object-contain" />
            </div>
            <Textarea
              aria-label="建议的描述"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="h-20 resize-none"
            />
            <p className="text-caption text-ink-2">
              {current.picture.regions.length
                ? `GBC 还找到了 ${current.picture.regions.length} 个区域，存在 gbc/ 里备用。`
                : '这张图没有区域框。'}
              {image.caption?.trim() ? '这张原来有描述，接受会替换它。' : ''}
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => next(false)}>跳过</Button>
              <Button onClick={acceptAll}>全部接受</Button>
              <Button tone="primary" onClick={() => next(true)} disabled={!draft.trim()}>
                {image.caption?.trim() ? '替换并继续' : '接受并继续'}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  )
}
