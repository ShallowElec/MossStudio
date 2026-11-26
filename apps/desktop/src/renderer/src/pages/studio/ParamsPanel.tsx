import { ChevronDown, Lock, LockOpen, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Notice } from '../../components/common/Notice'
import { LoraTriggerBar } from '../../components/studio/LoraTriggerBar'
import { findLoraProfile, mergeEntryLoraProfile, useLoraProfiles } from '../../components/studio/loraProfilesClient'
import { isSharedModelId } from '@shared/sharedModels'
import type { RemoteWorkerModelItem } from '@shared/remoteWorker'
import type { AdapterEntry, Catalog, GpuInventorySnapshot, ManagedHost, ProjectCanvas, Settings } from '@shared/types'
import {
  ADAPTER_STRENGTH_MAX,
  ADAPTER_STRENGTH_MIN,
  ADAPTER_STRENGTH_STEP,
  adapterStatuses,
  clampAdapterStrength,
  formatAdapterStrength,
  normalizeCanvasAdapters,
} from '@shared/adapters'
import {
  Advanced,
  Button,
  EmptyState,
  FieldLabel,
  IconButton,
  Input,
  Kbd,
  Modal,
  Pill,
  Segmented,
  Select,
  Spinner,
  Textarea,
  cn,
  useCopyText,
} from '../../components/ui'
import {
  MP_TIERS,
  QUALITY_PRESETS,
  SIZE_PRESETS,
  clampDimension,
  isSeedLocked,
  parseSeed,
  qualityFor,
  qualityPreset,
  qualityLabel,
  sizeChoiceFor,
  sizeForMegapixels,
  type ImageSize,
  type MegapixelTier,
  type QualityId,
  type SizePresetId,
} from './defaults'
import { dimensions, pixelCount } from '../../lib/format'
import { canvasDescription, withDescription, type CompiledPrompt } from './prompt'
import { installedBundles, type Blocker, type BundleChoice } from './readiness'
import { isWorkerDaemonHost, workerModelBundles, type WorkerAdapterEntry } from './remoteWorkerLoras'
import { ModelPicker } from './ModelPicker'
import { ModelName } from '../../components/common/ModelName'
import { bundleComponentIds, sizeText } from '../models/logic'
import type { Preparation } from '../../lib/preparation'
import { resizeCanvas } from './canvases'
import { useApp } from '../../store'
import { followDefaultLabel, gpuPickerLabel } from '../settings/devicesModel'
import { ImageCardPanel } from './ImageCardPanel'
import { SliderField, SlotHeader, SlotRow } from './InputControls'
import { InputsSection, type InputsWiring } from './InputsSection'
import { SamplingSection } from './SamplingSection'
import { patchInit } from './links'
import { styleUsers, UPSCALE_DETAIL, UPSCALE_DETAIL_DEFAULT, UPSCALE_SCALES, withUpscaleScale } from './nodes'

const SHORTCUT = typeof window !== 'undefined' && window.clover?.platform === 'darwin' ? '⌘ ↵' : 'Ctrl ↵'

function imageSizeLabel({ width, height }: ImageSize): string {
  return `${dimensions(width, height)} · ${pixelCount(width * height)}`
}

/** Commit-on-blur number field, so typing "1" on the way to "1024" is not clamped. */
function DimensionInput({
  label,
  value,
  otherEdge,
  onCommit,
}: {
  label: string
  value: number
  otherEdge?: number
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const next = clampDimension(Number(draft), value, otherEdge)
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }
  return (
    <Input
      aria-label={label}
      inputMode="numeric"
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
      className="tabular text-center"
    />
  )
}

export interface ParamsPanelProps {
  canvas: ProjectCanvas | null
  regionCount: number
  catalog: Catalog | null
  bundle: BundleChoice
  /** Real models detected on the Worker host picked as 运行位置; null/absent for this computer and SSH hosts. */
  workerModels?: {
    models: readonly RemoteWorkerModelItem[]
    unsupported?: boolean
    loading: boolean
    error: string | null
    reload: (rescan?: boolean) => void
  } | null
  /** The LoRA of the Worker host picked as 运行位置 (null while unknown); absent for this computer and SSH hosts. */
  workerAdapters?: readonly WorkerAdapterEntry[] | null
  settings: Settings | null
  gpuInventory: GpuInventorySnapshot | null
  hosts: ManagedHost[]
  remoteHostId: string
  onRemoteHostChange: (id: string) => void
  blockers: Blocker[]
  /** First-run preparation still downloading: 生成 fills up and says so. */
  waiting?: Preparation | null
  prompt: CompiledPrompt | null
  /** A run in its lineage, started from another canvas, is going: it cannot start yet. */
  blocked: boolean
  /** Its own runs going: 生成 becomes 再来一张 and queues another. */
  going: boolean
  /** Runs waiting behind the one being drawn. */
  queued: number
  /** As many runs wait as may (MAX_QUEUED_RUNS). */
  full: boolean
  onChange: (update: (canvas: ProjectCanvas) => ProjectCanvas) => void
  onPickBundle: (id: string) => void
  onOpenAdapters: () => void
  onGenerate: () => void
  onCopyAsLayout: () => void
  onAddCanvas: () => void
  onNavigate: (to: string) => void
  /** Pictures, engine features and pick mode for the 输入 and sampling sections. */
  inputs?: InputsWiring
  /** The selected 画面's regions (shown when it has any). */
  regions?: React.ReactNode
  /** For a picture card: make a new canvas that starts from it. */
  onUseAsStart?: (imageCanvasId: string) => void
}

export function ParamsPanel(props: ParamsPanelProps): React.JSX.Element {
  const { canvas } = props
  if (!canvas) {
    return (
      <div className="flex h-full flex-col justify-center">
        <EmptyState
          title="还没有画面"
          description="新建一个画面，写一句描述就能开始生成。"
          action={
            <Button tone="primary" size="md" onClick={props.onAddCanvas}>
              新建画面
            </Button>
          }
        />
      </div>
    )
  }
  if (canvas.kind === 'image') return <ImageCardPanel canvas={canvas} onUseAsStart={props.onUseAsStart} />
  if (canvas.kind === 'style') return <StylePanel {...props} canvas={canvas} />
  return <CanvasParams {...props} canvas={canvas} />
}

function CanvasParams({
  canvas,
  regionCount,
  catalog,
  bundle,
  workerModels,
  workerAdapters,
  settings,
  gpuInventory,
  hosts,
  remoteHostId,
  onRemoteHostChange,
  blockers,
  waiting,
  prompt,
  blocked,
  going,
  queued,
  full,
  onChange,
  onPickBundle,
  onOpenAdapters,
  onGenerate,
  onCopyAsLayout,
  onNavigate,
  inputs,
  regions,
}: ParamsPanelProps & { canvas: ProjectCanvas }): React.JSX.Element {
  const copyText = useCopyText()
  const openUpdate = useApp((state) => state.setUpdatePopoverOpen)
  const readOnly = canvas.kind === 'result'
  const [customSize, setCustomSize] = useState<{ aspect: ImageSize; mp?: MegapixelTier } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const preset = sizeChoiceFor(canvas.width, canvas.height)
  const sizePreset: SizePresetId = customSize ? 'custom' : (preset?.id ?? 'custom')
  const aspect = sizePreset === 'custom' ? (customSize?.aspect ?? canvas) : sizePreset
  const tier = sizePreset === 'custom' ? customSize?.mp : preset?.mp
  const changeSize = (size: ImageSize): void => onChange((current) => resizeCanvas(current, size.width, size.height))
  const typeSize = (width: number, height: number): void => {
    setCustomSize({ aspect: { width, height } })
    changeSize({ width, height })
  }
  const quality = qualityFor(canvas.steps)
  const installed = installedBundles(catalog)
  const adapters = normalizeCanvasAdapters(canvas.adapters)
  // An engine without LoRA (兼容模式 / AMD 原生): nothing to add; rows already there stay so they can be removed.
  const loraUnsupported = inputs?.features ? !inputs.features.lora : false
  const remoteEnabled = settings?.remoteHostsEnabled === true
  const remoteHost = remoteEnabled ? (hosts.find((host) => host.id === remoteHostId) ?? null) : null
  const description = canvasDescription(canvas)
  const seedLocked = isSeedLocked(canvas)

  useEffect(() => setCustomSize(null), [canvas.id])

  const engineReadiness = useApp((state) => state.engineReadiness)
  const defaultGpu =
    settings?.gpuSelection && settings.gpuSelection !== 'auto'
      ? gpuInventory?.devices.find((device) => device.uuid === (settings.gpuSelection as { uuid: string }).uuid)
      : undefined
  const boundMissing = Boolean(
    canvas.deviceUuid && gpuInventory && !gpuInventory.devices.some((device) => device.uuid === canvas.deviceUuid),
  )
  const locationName = remoteHost ? remoteHost.name : '本机'
  // A Worker host brings its own model: the summary names the host, not a model of this computer.
  const workerHost = isWorkerDaemonHost(remoteHost) ? remoteHost : null
  // The collapsed row names what is inside, so a first-time user knows it opens
  // settings instead of reading the values as a status line.
  const advancedSummary = ['种子 / CFG / 设备', seedLocked ? `种子 ${canvas.seed}` : '随机', locationName].join(' · ')

  const sizeLabel = canvas.upscale
    ? `放大 ×${canvas.upscale.scale}`
    : sizePreset === 'custom'
      ? `${canvas.width} × ${canvas.height}`
      : sizePreset
  const activeAdapters = adapters.filter((adapter) => adapter.strength > 0)
  // Model, size and LoRA as separate pieces; the spaces keep the plain text readable ("MOSS-Image SFT INT8 1:1").
  const hasRealWorkerModel = Boolean(workerHost && bundle.bundle && !bundle.bundle.id.startsWith('remote-worker:'))
  const legacyWorkerDaemon = Boolean(workerHost && workerModels?.unsupported)
  const summary = (
    <>
      {hasRealWorkerModel && bundle.bundle ? (
        <>
          <ModelName item={bundle.bundle} />
          <span className="shrink-0 text-ink-2">· {workerHost!.name}</span>
        </>
      ) : workerHost ? (
        <span className="truncate">远端主机 · {workerHost.name}</span>
      ) : bundle.bundle ? (
        <ModelName item={bundle.bundle} />
      ) : (
        <span>没有模型</span>
      )}{' '}
      <span className="shrink-0 text-ink-2">{sizeLabel}</span>
      {activeAdapters.length ? (
        <>
          {' '}
          <span className="shrink-0 text-ink-2">LoRA {activeAdapters.length}</span>
        </>
      ) : null}
    </>
  )

  const workerBundles = useMemo(
    () => (workerHost && workerModels?.models.length ? workerModelBundles(workerModels.models) : []),
    [workerHost, workerModels?.models],
  )
  const workerInstalledIds = useMemo(() => {
    const ids = new Set<string>()
    for (const item of workerModels?.models ?? []) {
      ids.add(item.id)
      if (item.catalogBundleId) ids.add(item.catalogBundleId)
    }
    return ids
  }, [workerModels?.models])
  const notDownloaded = (catalog?.bundles ?? [])
    .filter((item) => !installed.some((entry) => entry.id === item.id))
    // Certified models first, as on the 模型 page.
    .sort((a, b) => Number(Boolean(b.certified)) - Number(Boolean(a.certified)))
  const workerNotDownloaded = legacyWorkerDaemon
    ? []
    : (catalog?.bundles ?? [])
        .filter((item) => !isSharedModelId(item.id) && item.id !== 'local-files' && !item.custom && !workerInstalledIds.has(item.id))
        .sort((a, b) => Number(Boolean(b.certified)) - Number(Boolean(a.certified)))
  const bundleSizes = new Map(
    installed.map((item) => [
      item.id,
      sizeText(bundleComponentIds(item).reduce((sum, id) => sum + (catalog?.models.find((model) => model.id === id)?.sizeBytes ?? 0), 0)),
    ]),
  )
  const workerBundleSizes = new Map((workerModels?.models ?? []).map((item) => [item.id, item.sizeBytes ? sizeText(item.sizeBytes) : '']))
  const activeInstalled = workerHost ? (legacyWorkerDaemon && bundle.bundle ? [bundle.bundle] : workerBundles) : installed
  const activeNotDownloaded = workerHost ? workerNotDownloaded : notDownloaded
  const activeSizes = workerHost ? workerBundleSizes : bundleSizes

  const setAdapters = (next: ProjectCanvas['adapters']): void =>
    onChange((current) => ({ ...current, adapters: normalizeCanvasAdapters(next) }))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="studio-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto pl-5 pr-3.5 pb-4 pt-5">
        {readOnly ? <Notice className="mb-5">参数已固定，复制成新画面后可改</Notice> : null}
        <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
          <section className="flex flex-col gap-2.5">
            {/* What the model is finally sent sits next to the description it is built from. */}
            <FieldLabel
              htmlFor="studio-description"
              value={
                <Button tone="ghost" size="xs" className="-mr-2" onClick={() => setPromptOpen(true)}>
                  查看最终提示词
                </Button>
              }
            >
              描述
            </FieldLabel>
            <Textarea
              id="studio-description"
              aria-label="描述"
              value={description}
              onChange={(event) => onChange((current) => withDescription(current, event.target.value))}
              placeholder={canvas.upscale ? '可以不写' : '想要什么样的画面？'}
              className="h-[116px] resize-none"
            />
          </section>

          {regionCount > 0 && regions ? regions : null}

          {/* A 放大's one input, its 原图, is wired on the board. */}
          {inputs && !readOnly && !canvas.upscale ? (
            <InputsSection canvas={canvas} onChange={onChange} wiring={inputs} blockers={blockers} />
          ) : null}

          {/* Model, size and LoRA fold into one line; it opens to change them. A change
              applies to the runs asked for after it: queued runs keep what they were sent
              with. */}
          <div className="flex min-w-0 flex-col gap-6">
            <button
              type="button"
              data-settings-summary
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
              className="flex h-9 items-center justify-between gap-2 rounded-md bg-well px-3 text-ui text-ink transition-colors hover:bg-well-strong"
            >
              <span className="tabular flex min-w-0 items-center gap-3 overflow-hidden">{summary}</span>
              <ChevronDown
                className={cn('size-4 shrink-0 text-ink-2 transition-transform', settingsOpen && 'rotate-180')}
                aria-hidden="true"
                strokeWidth={1.6}
              />
            </button>
            {settingsOpen ? (
              <>
                <section className="flex flex-col gap-2.5">
                  <FieldLabel
                    htmlFor="studio-model"
                    value={
                      workerHost && workerModels && !legacyWorkerDaemon ? (
                        <Button
                          tone="ghost"
                          size="xs"
                          className="-mr-2"
                          disabled={workerModels.loading}
                          onClick={() => workerModels.reload(true)}
                        >
                          <RefreshCw
                            className={cn('size-3', workerModels.loading && 'animate-spin')}
                            strokeWidth={1.6}
                            aria-hidden="true"
                          />
                          重新检测
                        </Button>
                      ) : undefined
                    }
                  >
                    {workerHost ? `模型 · ${workerHost.name}` : '模型'}
                  </FieldLabel>
                  <ModelPicker
                    id="studio-model"
                    current={bundle.bundle}
                    installed={activeInstalled}
                    others={activeNotDownloaded}
                    sizes={activeSizes}
                    disabled={
                      readOnly ||
                      legacyWorkerDaemon ||
                      (!workerHost && !catalog) ||
                      (Boolean(workerHost) && Boolean(workerModels?.loading) && !activeInstalled.length)
                    }
                    placeholder={
                      workerHost
                        ? workerModels?.loading
                          ? '正在检测远端模型…'
                          : workerModels?.error
                            ? '无法读取远端模型'
                            : '远端未检测到模型'
                        : catalog
                          ? '还没有可用的模型'
                          : '正在读取模型…'
                    }
                    onPick={onPickBundle}
                    onDownload={(id) =>
                      onNavigate(
                        workerHost
                          ? `/models?hostId=${encodeURIComponent(workerHost.id)}&bundle=${encodeURIComponent(id)}`
                          : `/models?bundle=${encodeURIComponent(id)}`,
                      )
                    }
                  />
                  {workerHost && workerModels?.error ? (
                    <Notice
                      tone="warn"
                      action={
                        <Button size="xs" onClick={() => workerModels.reload(true)}>
                          重试
                        </Button>
                      }
                    >
                      无法检测 {workerHost.name} 上的模型：{workerModels.error}
                    </Notice>
                  ) : null}
                  <LoraSection
                    adapters={adapters}
                    catalog={catalog}
                    entries={workerHost ? workerAdapters : undefined}
                    readOnly={readOnly}
                    unsupported={loraUnsupported}
                    description={description}
                    onDescriptionChange={(update) => onChange((current) => withDescription(current, update(canvasDescription(current))))}
                    onOpenAdapters={onOpenAdapters}
                    onChange={setAdapters}
                  />
                </section>

                {canvas.upscale ? (
                  <UpscaleSection canvas={canvas} canvases={inputs?.canvases ?? []} onChange={onChange} />
                ) : (
                  <section className="flex flex-col gap-2.5">
                    <FieldLabel value={imageSizeLabel(canvas)}>尺寸</FieldLabel>
                    <Segmented<SizePresetId>
                      block
                      label="尺寸"
                      value={sizePreset}
                      onChange={(value) => {
                        if (value === 'custom') {
                          setCustomSize({ aspect: { width: canvas.width, height: canvas.height } })
                          return
                        }
                        setCustomSize(null)
                        changeSize(sizeForMegapixels(value, tier ?? 1))
                      }}
                      options={[
                        ...SIZE_PRESETS.map(({ id }) => ({
                          value: id,
                          label: id,
                          hint: imageSizeLabel(sizeForMegapixels(id, tier ?? 1)),
                        })),
                        { value: 'custom' as const, label: '自定义' },
                      ]}
                      className="grid grid-cols-4 gap-0.5 [&>button]:px-1"
                    />
                    <FieldLabel htmlFor="studio-size-tier">像素档位</FieldLabel>
                    <Select
                      id="studio-size-tier"
                      value={tier === undefined ? '' : String(tier)}
                      onValueChange={(value) => {
                        const mp = MP_TIERS.find((item) => String(item) === value)
                        if (mp === undefined) return
                        if (typeof aspect !== 'string') setCustomSize({ aspect: { width: aspect.width, height: aspect.height }, mp })
                        changeSize(sizeForMegapixels(aspect, mp))
                      }}
                      options={[
                        ...(tier === undefined ? [{ value: '', label: '自定义像素', disabled: true }] : []),
                        ...MP_TIERS.map((mp) => {
                          const size = sizeForMegapixels(aspect, mp)
                          return { value: String(mp), label: `${pixelCount(mp * 1_000_000)} · ${dimensions(size.width, size.height)}` }
                        }),
                      ]}
                    />
                    {sizePreset === 'custom' && !readOnly ? (
                      <div className="flex items-center gap-2">
                        <DimensionInput
                          label="宽度"
                          value={canvas.width}
                          otherEdge={canvas.height}
                          onCommit={(width) => typeSize(width, canvas.height)}
                        />
                        <span aria-hidden="true" className="text-ink-2">
                          ×
                        </span>
                        <DimensionInput
                          label="高度"
                          value={canvas.height}
                          otherEdge={canvas.width}
                          onCommit={(height) => typeSize(canvas.width, height)}
                        />
                      </div>
                    ) : null}
                  </section>
                )}
              </>
            ) : null}

            <section className="flex flex-col gap-2.5">
              <FieldLabel value={qualityLabel(canvas.steps)}>质量</FieldLabel>
              <Segmented<QualityId | 'custom'>
                block
                label="质量"
                value={quality}
                onChange={(value) => {
                  if (value === 'custom') return
                  const preset = qualityPreset(value)
                  onChange((current) => ({ ...current, steps: preset.steps, cfg: preset.cfg }))
                }}
                options={QUALITY_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, hint: preset.hint }))}
              />
            </section>

            <Advanced dense title="高级设置" summary={advancedSummary} className="-mx-3.5">
              <div className="flex flex-col gap-5 px-3.5 pb-2 pt-2">
                <section className="flex flex-col gap-2">
                  <FieldLabel htmlFor="studio-seed">种子</FieldLabel>
                  <div className="flex items-center gap-1.5">
                    <Input
                      id="studio-seed"
                      inputMode="numeric"
                      className="tabular"
                      value={seedLocked ? String(canvas.seed) : ''}
                      placeholder={canvas.seed ? `随机 · 上次 ${canvas.seed}` : '随机'}
                      onChange={(event) => {
                        const seed = parseSeed(event.target.value)
                        if (event.target.value.trim() === '') onChange((current) => ({ ...current, seedLocked: false }))
                        else if (seed !== null) onChange((current) => ({ ...current, seed, seedLocked: true }))
                      }}
                    />
                    <IconButton
                      label={seedLocked ? '解锁种子（每次随机）' : '锁定种子（保持不变）'}
                      aria-pressed={seedLocked}
                      className={cn(seedLocked && 'bg-well-strong text-ink')}
                      onClick={() => onChange((current) => ({ ...current, seedLocked: !isSeedLocked(current) }))}
                    >
                      {seedLocked ? <Lock className="size-4" strokeWidth={1.6} /> : <LockOpen className="size-4" strokeWidth={1.6} />}
                    </IconButton>
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <SliderField
                    id="studio-cfg"
                    label="CFG"
                    min={0}
                    max={10}
                    step={0.5}
                    value={canvas.cfg}
                    format={(value) => String(value)}
                    onChange={(cfg) => onChange((current) => ({ ...current, cfg }))}
                  />
                </section>

                <section className="flex flex-col gap-2">
                  <FieldLabel htmlFor="studio-negative">不想出现的内容</FieldLabel>
                  <Textarea
                    id="studio-negative"
                    value={canvas.negative}
                    onChange={(event) => onChange((current) => ({ ...current, negative: event.target.value }))}
                    className="min-h-[64px] resize-none"
                    rows={2}
                  />
                </section>

                {inputs ? <SamplingSection canvas={canvas} features={inputs.features} worker={inputs.worker} onChange={onChange} /> : null}

                {remoteEnabled ? (
                  <section className="flex flex-col gap-2">
                    <FieldLabel htmlFor="studio-location">运行位置</FieldLabel>
                    <Select id="studio-location" value={remoteHost?.id ?? ''} onChange={(event) => onRemoteHostChange(event.target.value)}>
                      <option value="">这台电脑</option>
                      {hosts.map((host) => (
                        <option key={host.id} value={host.id}>
                          {host.status === 'error' ? `${host.name}（连接不上）` : host.name}
                        </option>
                      ))}
                    </Select>
                  </section>
                ) : null}

                {remoteHost ? (
                  remoteHost.devices.length ? (
                    <section className="flex flex-col gap-2">
                      <FieldLabel htmlFor="studio-remote-gpu">显卡</FieldLabel>
                      <Select
                        id="studio-remote-gpu"
                        value={canvas.deviceId ?? ''}
                        onChange={(event) => onChange((current) => ({ ...current, deviceId: event.target.value || undefined }))}
                      >
                        <option value="">自动选择</option>
                        {remoteHost.devices.map((device) => (
                          <option key={device.id} value={device.id}>
                            {device.name}
                          </option>
                        ))}
                      </Select>
                    </section>
                  ) : null
                ) : (
                  <section className="flex flex-col gap-2">
                    <FieldLabel htmlFor="studio-gpu">显卡</FieldLabel>
                    <Select
                      id="studio-gpu"
                      value={canvas.deviceUuid ?? ''}
                      onChange={(event) => onChange((current) => ({ ...current, deviceUuid: event.target.value || undefined }))}
                    >
                      <option value="">{followDefaultLabel(defaultGpu, engineReadiness)}</option>
                      {boundMissing ? (
                        <option value={canvas.deviceUuid} disabled>
                          之前选的显卡现在找不到
                        </option>
                      ) : null}
                      {(gpuInventory?.devices ?? []).map((device) => (
                        <option key={device.uuid} value={device.uuid}>
                          {gpuPickerLabel(device, engineReadiness)}
                        </option>
                      ))}
                    </Select>
                    {boundMissing ? <Notice tone="warn">之前选的显卡现在找不到，生成前请换一个或改回默认。</Notice> : null}
                  </section>
                )}
              </div>
            </Advanced>
          </div>
        </fieldset>
      </div>

      <div className="flex shrink-0 flex-col gap-2.5 px-5 pb-4 pt-3">
        {readOnly ? (
          <Button tone="primary" size="lg" block onClick={onCopyAsLayout}>
            复制为新画面
          </Button>
        ) : (
          <>
            {blockers.length ? (
              <ul aria-live="polite" className="flex flex-col gap-1.5">
                {blockers.map((blocker, index) => (
                  // Every reason not to generate reads the same: a Notice with the action that fixes it.
                  <li key={`${blocker.id}-${index}`}>
                    <Notice
                      action={
                        blocker.action ? (
                          <Button
                            size="xs"
                            onClick={() => (blocker.action!.opens === 'update' ? openUpdate(true) : onNavigate(blocker.action!.to))}
                          >
                            {blocker.action.label}
                          </Button>
                        ) : undefined
                      }
                    >
                      {blocker.message}
                    </Notice>
                  </li>
                ))}
              </ul>
            ) : null}
            <Button
              tone="primary"
              size="lg"
              block
              data-studio-generate
              aria-busy={blocked}
              disabled={blocked || full || blockers.length > 0 || Boolean(waiting)}
              onClick={onGenerate}
              title={blocked ? '这个画面或它的来源正在生成' : undefined}
              className={waiting ? 'relative overflow-hidden' : undefined}
            >
              {waiting ? (
                <>
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 bg-accent-soft"
                    style={{ width: `${Math.round(waiting.percent)}%` }}
                  />
                  <span className="tabular relative">下载完成后就能生成 · {Math.round(waiting.percent)}%</span>
                </>
              ) : (
                <>
                  {blocked ? <Spinner /> : null}
                  {blocked ? '生成中…' : full ? '排队已满' : going ? '再来一张' : '生成'}
                  {!blocked && !full ? <Kbd>{SHORTCUT}</Kbd> : null}
                  {queued && !blocked ? (
                    <Pill tone="accent-strong" className="tabular">
                      <span data-generate-queue>排队 {queued}</span>
                    </Pill>
                  ) : null}
                </>
              )}
            </Button>
          </>
        )}
      </div>

      <Modal
        open={promptOpen}
        onClose={() => setPromptOpen(false)}
        title="最终提示词"
        description="这是生成时实际发送给模型的内容，由描述和可见的区域组成。"
        width="max-w-3xl"
        footer={
          <>
            <Button tone="ghost" size="md" onClick={() => setPromptOpen(false)}>
              关闭
            </Button>
            <Button
              tone="secondary"
              size="md"
              disabled={!prompt?.ok}
              onClick={() => {
                if (prompt?.ok) void copyText(prompt.prompt, '已复制最终提示词')
              }}
            >
              复制
            </Button>
          </>
        }
      >
        {prompt?.ok ? (
          <pre className="selectable max-h-[52vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-well p-3 font-mono text-caption text-ink">
            {prompt.preview}
          </pre>
        ) : (
          <p className="text-control text-ink-2">{prompt?.errors[0] ?? '描述还不完整'}</p>
        )}
      </Modal>
    </div>
  )
}

/** The LoRA rows of a 画面 or a 风格: each with its strength, plus 添加. */
export function LoraSection({
  adapters,
  catalog,
  entries,
  readOnly = false,
  unsupported = false,
  hint,
  description,
  onDescriptionChange,
  onOpenAdapters,
  onChange,
}: {
  adapters: ReturnType<typeof normalizeCanvasAdapters>
  catalog: Catalog | null
  /** The Worker host's LoRA instead of this computer's library; null while unknown (rows then never show as missing). */
  entries?: readonly WorkerAdapterEntry[] | null
  readOnly?: boolean
  /** The engine has no LoRA: nothing to add; rows already there stay so they can be removed. */
  unsupported?: boolean
  hint?: string
  /** The description trigger words are written into; without it the trigger chips only show. */
  description?: string
  onDescriptionChange?: (update: (description: string) => string) => void
  onOpenAdapters: () => void
  onChange: (next: ProjectCanvas['adapters']) => void
}): React.JSX.Element | null {
  const profiles = useLoraProfiles()
  const library: readonly AdapterEntry[] | undefined = entries === undefined ? catalog?.adapters : (entries ?? undefined)
  const adapterRows = adapterStatuses(adapters, library).map((row) =>
    // Not read from the Worker yet: unknown, not missing.
    entries === null || (entries && !entries.length) ? { ...row, installed: true } : row,
  )
  const loraUnsupported = unsupported
  const setAdapters = onChange
  return (
    <>
      {loraUnsupported && !adapterRows.length ? null : (
        <SlotHeader title="LoRA" hint={hint}>
          {readOnly || loraUnsupported ? null : (
            <Button tone="ghost" size="xs" className="-mr-2" onClick={onOpenAdapters} data-adapter-picker>
              <Plus className="size-3.5" aria-hidden="true" strokeWidth={1.6} />
              添加
            </Button>
          )}
        </SlotHeader>
      )}
      {adapterRows.length ? (
        <div className="flex flex-col gap-1">
          {adapterRows.map(({ adapter, name, installed: present }) => {
            const entry = library?.find((item) => item.id === adapter.id)
            const profile = mergeEntryLoraProfile(adapter.path ?? adapter.id, entry, findLoraProfile(profiles, adapter))
            const disabledZero = adapter.strength <= 0
            return (
              <SlotRow
                key={adapter.id}
                data-adapter-row={adapter.id}
                title={disabledZero ? `${name}（强度 0 · 已停用）` : present ? name : `${name}（找不到文件）`}
                titleTone={disabledZero || present ? 'ink' : 'warn'}
                removeLabel={`移除 ${name}`}
                onRemove={readOnly ? undefined : () => setAdapters(adapters.filter((item) => item.id !== adapter.id))}
              >
                <SliderField
                  label="强度"
                  ariaLabel={`${name} 强度`}
                  min={ADAPTER_STRENGTH_MIN}
                  max={ADAPTER_STRENGTH_MAX}
                  step={ADAPTER_STRENGTH_STEP}
                  value={adapter.strength}
                  format={formatAdapterStrength}
                  onChange={(value) =>
                    setAdapters(
                      adapters.map((item) => (item.id === adapter.id ? { ...item, strength: clampAdapterStrength(value) } : item)),
                    )
                  }
                />
                {readOnly && !profile?.triggers.length ? null : (
                  <LoraTriggerBar
                    adapter={adapter}
                    name={name}
                    profile={profile}
                    description={description ?? ''}
                    readOnly={readOnly}
                    onDescriptionChange={onDescriptionChange}
                  />
                )}
              </SlotRow>
            )
          })}
        </div>
      ) : null}
    </>
  )
}

/** A 放大's size: how many times the 原图, and how much it redraws. */
function UpscaleSection({
  canvas,
  canvases,
  onChange,
}: {
  canvas: ProjectCanvas
  canvases: readonly ProjectCanvas[]
  onChange: (update: (canvas: ProjectCanvas) => ProjectCanvas) => void
}): React.JSX.Element {
  const strength = canvas.inputs?.init?.strength ?? UPSCALE_DETAIL_DEFAULT
  const detail = UPSCALE_DETAIL.reduce((best, item) =>
    Math.abs(item.strength - strength) < Math.abs(best.strength - strength) ? item : best,
  )
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <FieldLabel value={canvas.inputs?.init ? `${canvas.width} × ${canvas.height}` : '先接一张原图'}>放大倍数</FieldLabel>
        <Segmented<string>
          block
          label="放大倍数"
          value={String(canvas.upscale?.scale ?? 2)}
          onChange={(value) => onChange((current) => withUpscaleScale(current, Number(value), canvases))}
          options={UPSCALE_SCALES.map((scale) => ({ value: String(scale), label: `×${scale}` }))}
        />
      </section>
      <section className="flex flex-col gap-2.5">
        <FieldLabel value={`重绘 ${Math.round(strength * 100)}%`}>细节</FieldLabel>
        <Segmented<string>
          block
          label="细节"
          value={detail.id}
          onChange={(value) => {
            const choice = UPSCALE_DETAIL.find((item) => item.id === value)
            if (choice) onChange((current) => patchInit(current, { strength: choice.strength }))
          }}
          options={UPSCALE_DETAIL.map((item) => ({ value: item.id, label: item.label }))}
        />
      </section>
    </>
  )
}

/** A 风格: its name, the description and LoRA it adds, and the 画面 that use it. */
function StylePanel({
  canvas,
  catalog,
  workerAdapters,
  inputs,
  onChange,
  onOpenAdapters,
}: ParamsPanelProps & { canvas: ProjectCanvas }): React.JSX.Element {
  const users = styleUsers(canvas.id, inputs?.canvases ?? [])
  const loraUnsupported = inputs?.features ? !inputs.features.lora : false
  return (
    <div className="studio-scroll flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto pl-5 pr-3.5 pb-4 pt-5">
      <div className="flex min-w-0 flex-col gap-6">
        <section className="flex flex-col gap-2.5">
          <FieldLabel htmlFor="studio-style-name">风格名称</FieldLabel>
          <Input
            id="studio-style-name"
            value={canvas.title}
            maxLength={40}
            onChange={(event) => onChange((current) => ({ ...current, title: event.target.value }))}
            onBlur={(event) => {
              if (!event.target.value.trim()) onChange((current) => ({ ...current, title: '风格' }))
            }}
          />
        </section>
        <section className="flex flex-col gap-2.5">
          <FieldLabel htmlFor="studio-style-text">风格描述</FieldLabel>
          <Textarea
            id="studio-style-text"
            aria-label="风格描述"
            value={canvas.prompt}
            onChange={(event) => onChange((current) => withDescription(current, event.target.value))}
            placeholder="这组图共同的样子，例如：水彩插画，柔和的粉色调，留白多"
            className="h-[116px] resize-none"
          />
        </section>
        <section className="flex flex-col gap-2.5">
          <LoraSection
            adapters={normalizeCanvasAdapters(canvas.adapters)}
            catalog={catalog}
            entries={workerAdapters}
            unsupported={loraUnsupported}
            description={canvas.prompt}
            onDescriptionChange={(update) => onChange((current) => withDescription(current, update(current.prompt)))}
            onOpenAdapters={onOpenAdapters}
            onChange={(next) => onChange((current) => ({ ...current, adapters: normalizeCanvasAdapters(next) }))}
          />
        </section>
        <section className="flex flex-col gap-1.5" data-style-users>
          <FieldLabel value={users.length ? `${users.length} 个` : undefined}>用在</FieldLabel>
          {users.length ? (
            <p className="text-ui text-ink">{users.map((user) => user.title).join('、')}</p>
          ) : (
            <p className="text-ui text-ink-2">—</p>
          )}
        </section>
      </div>
    </div>
  )
}
