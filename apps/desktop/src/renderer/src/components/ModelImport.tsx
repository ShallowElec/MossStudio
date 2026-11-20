import { FileUp, FolderOpen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { cliGpuUuids, generationGpus } from '@shared/bundleFit'
import { Events, Ipc } from '@shared/channels'
import type { Catalog, ModelImportState } from '@shared/types'
import { call, onEvent } from '../lib/api'
import { droppedPaths, useModelImport } from '../lib/modelImport'
import { useGpuInventory } from '../lib/useGpuInventory'
import { CombinationDialog } from '../pages/models/CombinationDialog'
import { DownloadProgress } from '../pages/models/DownloadProgress'
import { importModels, importProgress, importRow, importTitle, type ImportModelView } from '../pages/models/importView'
import { useModelLocation } from '../pages/models/useModelLocation'
import { useApp } from '../store'
import { Notice } from './common/Notice'
import { Button, FieldLabel, Group, Pill, ProgressBar, Row, Sheet, Spinner, Tag, useToast } from './ui'

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** 自己组合 with the parts an import could not settle on by itself. */
function ChooseParts({
  catalog,
  initial,
  onClose,
}: {
  catalog: Catalog
  initial: NonNullable<ModelImportState['choose']>
  onClose: () => void
}): React.JSX.Element {
  const location = useModelLocation(null)
  return <CombinationDialog open catalog={catalog} location={location} initial={initial} onClose={onClose} />
}

function ModelResult({
  model,
  named,
  primary,
  busy,
  onDownload,
}: {
  model: ImportModelView
  /** The sheet's title already says 可以用了 with this model's name. */
  named: boolean
  primary: boolean
  busy: boolean
  onDownload: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-panel px-4 py-3" data-import-model={model.bundle.id}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-control text-ink">
            {model.status === 'ready' && !named ? `可以用了：${model.bundle.name}` : model.bundle.name}
          </span>
          {model.status === 'ready' ? (
            <span className="text-caption text-ink-2">在原位置使用，不占额外空间</span>
          ) : model.reason ? (
            <span className="text-caption text-ink-2">{model.reason}</span>
          ) : null}
        </div>
        {model.status === 'blocked' ? <Pill tone="warn">用不了</Pill> : null}
        {model.action ? (
          <Button tone={primary ? 'primary' : 'secondary'} disabled={busy} onClick={onDownload}>
            {busy ? <Spinner /> : null}
            {model.action}
          </Button>
        ) : null}
      </div>
      {model.progress ? <DownloadProgress info={model.progress} label={`${model.bundle.name} 下载进度`} /> : null}
    </div>
  )
}

/**
 * The 导入模型 sheet: the two ways to pick files, then one row per file while
 * the engine checks it, then the models that can be used. `onUse` is what the
 * main action does with a ready model (去创作, or in first-run setup, picking it).
 */
export function ModelImportSheet({
  extra,
  useLabel = '去创作',
  onUse,
  onInstallEngine,
}: {
  /** Shown under the two buttons before anything is picked (first-run setup's shared folders). */
  extra?: ReactNode
  useLabel?: string
  onUse: (bundleId: string) => void
  onInstallEngine: () => void
}): React.JSX.Element {
  const toast = useToast()
  const { state, open, setState, pick, close } = useModelImport()
  const catalog = useApp((app) => app.catalog)
  const downloads = useApp((app) => app.downloads)
  const settings = useApp((app) => app.settings)
  const engineReadiness = useApp((app) => app.engineReadiness)
  const downloadBundle = useApp((app) => app.downloadBundle)
  const { inventory } = useGpuInventory()
  const place = useMemo(
    () => ({ remote: false, gpus: generationGpus(inventory?.devices, settings), cliGpus: cliGpuUuids(engineReadiness) }),
    [inventory, settings, engineReadiness],
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

  useEffect(() => {
    void call<ModelImportState | null>(Ipc.modelsImportState)
      .then((current) => {
        if (current) setState(current)
      })
      .catch(() => undefined)
    return onEvent<ModelImportState>(Events.modelImport, (next) => {
      const before = useModelImport.getState().state
      setState(next)
      // Finished while the sheet was closed (在后台继续): say so once.
      if (next.phase === 'done' && before?.id === next.id && before.phase !== 'done' && !openRef.current) {
        toast.push(`识别完了：${next.files.length} 个文件`, 'success')
      }
    })
  }, [setState, toast])

  const models = state && catalog ? importModels(state, catalog, downloads, place) : []
  const rows = state ? state.files.map((file) => importRow(file, place)) : []
  const progress = state ? importProgress(state) : null
  const done = state?.phase === 'done'
  const ready = models.filter((model) => model.status === 'ready')
  const usable = rows.filter((row) => !row.unusable)
  const unusable = done ? rows.filter((row) => row.unusable) : []

  async function run(key: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(key)
    try {
      await action()
    } catch (cause) {
      toast.push(errorText(cause), 'error')
    } finally {
      setBusy(null)
    }
  }

  const pickButtons = (
    <div className="flex flex-wrap gap-2">
      <Button tone="secondary" size="md" onClick={() => void run('pick', () => pick('files'))}>
        <FileUp className="size-4" strokeWidth={1.6} />
        选择文件…
      </Button>
      <Button tone="secondary" size="md" onClick={() => void run('pick', () => pick('folder'))}>
        <FolderOpen className="size-4" strokeWidth={1.6} />
        选择文件夹…
      </Button>
    </div>
  )

  const footer = !state ? null : done ? (
    <>
      {state.choose ? (
        <Button tone="secondary" size="md" onClick={() => setChoosing(true)}>
          自己组合
        </Button>
      ) : null}
      <Button tone="ghost" size="md" onClick={close}>
        留在这里
      </Button>
      {ready[0] ? (
        <Button
          tone="primary"
          size="md"
          onClick={() => {
            close()
            onUse(ready[0]!.bundle.id)
          }}
        >
          {useLabel}
        </Button>
      ) : null}
    </>
  ) : (
    <Button tone="ghost" size="md" onClick={close}>
      在后台继续
    </Button>
  )

  return (
    <>
      <Sheet open={open} title={importTitle(state, models)} onClose={close} footer={footer}>
        <div className="flex flex-col gap-4" data-model-import={state?.phase ?? 'idle'}>
          {!state ? (
            <>
              {pickButtons}
              {extra}
            </>
          ) : (
            <>
              {progress && !done ? (
                <div className="flex flex-col gap-1.5">
                  <ProgressBar value={progress.percent} size="md" label="识别进度" />
                  <span className="tabular text-caption text-ink-2">
                    {progress.done} / {progress.total}
                  </span>
                </div>
              ) : null}
              {state.phase === 'waiting-engine' ? (
                <Notice
                  action={
                    <Button size="xs" onClick={onInstallEngine}>
                      装引擎
                    </Button>
                  }
                >
                  装好引擎后才能认出这些文件
                </Notice>
              ) : null}
              {models.map((model, index) => (
                <ModelResult
                  key={model.bundle.id}
                  model={model}
                  named={ready.length === 1}
                  primary={ready.length === 0 && index === models.findIndex((item) => item.action)}
                  busy={busy === model.bundle.id}
                  onDownload={() => void run(model.bundle.id, () => downloadBundle(model.bundle.id))}
                />
              ))}
              {usable.length ? (
                <Group tone="panel">
                  {usable.map((row) => (
                    <Row key={row.path} title={row.name} description={row.line ?? undefined}>
                      {row.busy ? <Spinner className="text-ink-2" /> : row.tag ? <Tag>{row.tag}</Tag> : null}
                    </Row>
                  ))}
                </Group>
              ) : null}
              {unusable.length ? (
                <div className="flex flex-col gap-2">
                  <FieldLabel as="h3">用不了的文件</FieldLabel>
                  <Group tone="panel">
                    {unusable.map((row) => (
                      <Row key={row.path} title={row.name} description={row.line ?? undefined}>
                        {row.offer ? (
                          <Button disabled={busy !== null} onClick={() => void run(row.path, () => downloadBundle(row.offer!.bundleId))}>
                            {busy === row.path ? <Spinner /> : null}
                            {row.offer.label}
                          </Button>
                        ) : (
                          <Pill tone="warn">用不了</Pill>
                        )}
                      </Row>
                    ))}
                  </Group>
                </div>
              ) : null}
              {done ? pickButtons : null}
            </>
          )}
        </div>
      </Sheet>
      {choosing && state?.choose && catalog ? (
        <ChooseParts catalog={catalog} initial={state.choose} onClose={() => setChoosing(false)} />
      ) : null}
    </>
  )
}

/**
 * Files dragged onto the window from outside: a full-window layer says what
 * letting go does, and the drop starts an import. A place that takes the files
 * itself (the Studio board, a picture field) handles the drag first and the
 * layer stays away.
 */
export function ModelDropOverlay(): React.JSX.Element | null {
  const start = useModelImport((store) => store.start)
  const toast = useToast()
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    // A drag that starts inside the window (a picture, a card) is not an import.
    let inside = false
    const hasFiles = (event: DragEvent): boolean => !inside && [...(event.dataTransfer?.types ?? [])].includes('Files')
    const onStart = (): void => {
      inside = true
    }
    const onEnd = (): void => {
      inside = false
      setCount(null)
    }
    const onOver = (event: DragEvent): void => {
      if (!hasFiles(event) || event.defaultPrevented) {
        setCount(null)
        return
      }
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setCount(event.dataTransfer?.items.length ?? 0)
    }
    const onLeave = (event: DragEvent): void => {
      if (event.relatedTarget === null) setCount(null)
    }
    const onDrop = (event: DragEvent): void => {
      setCount(null)
      if (!hasFiles(event) || event.defaultPrevented) return
      event.preventDefault()
      const paths = droppedPaths(event.dataTransfer?.files)
      if (paths.length) void start(paths).catch((cause: unknown) => toast.push(errorText(cause), 'error'))
    }
    window.addEventListener('dragstart', onStart)
    window.addEventListener('dragend', onEnd)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragstart', onStart)
      window.removeEventListener('dragend', onEnd)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [start, toast])

  if (count === null) return null
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: 'var(--scrim)' }}
      data-model-drop
    >
      <div className="flex flex-col items-center gap-1.5 rounded-xl bg-raised px-8 py-6 shadow-float">
        <span className="text-section font-semibold text-ink">松开导入模型、LoRA 或控制适配器</span>
        {count > 0 ? <span className="tabular text-ui text-ink-2">{count} 个文件</span> : null}
      </div>
    </div>
  )
}

/** The main window's import: the drop layer and the sheet, whose main action opens 创作 with the model. */
export function ModelImportHost(): React.JSX.Element {
  const navigate = useNavigate()
  const requestStudioModel = useApp((app) => app.requestStudioModel)
  return (
    <>
      <ModelDropOverlay />
      <ModelImportSheet
        onUse={(bundleId) => {
          requestStudioModel(bundleId)
          void navigate('/studio')
        }}
        onInstallEngine={() => {
          useModelImport.getState().close()
          void navigate('/settings/devices')
        }}
      />
    </>
  )
}
