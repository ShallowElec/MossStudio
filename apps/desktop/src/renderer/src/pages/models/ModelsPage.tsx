import { ChevronDown, Download, FolderOpen, Package, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { cliGpuUuids, generationGpus } from '@shared/bundleFit'
import { isSharedModelId } from '@shared/sharedModels'
import { Ipc } from '@shared/channels'
import type { SlotKey } from '@shared/modelCombos'
import type { AppInfo, Catalog, ModelBundle, ModelSourceFile, ModelSourceStatus } from '@shared/types'
import { call } from '../../lib/api'
import { useModelImport } from '../../lib/modelImport'
import { useGpuInventory } from '../../lib/useGpuInventory'
import { DownloadQueue } from '../../components/DownloadQueue'
import { MenuItem, Popover } from '../../components/common/Popover'
import { Notice } from '../../components/common/Notice'
import {
  Advanced,
  Button,
  EmptyState,
  Group,
  IconButton,
  LoadingRow,
  PageHeader,
  PageScroll,
  Row,
  Section,
  Segmented,
  Select,
  Tabs,
  useToast,
} from '../../components/ui'
import { useApp } from '../../store'
import { AdvancedPanel } from './AdvancedPanel'
import { CombinationDialog } from './CombinationDialog'
import { ControlAdaptersSection } from './ControlAdaptersSection'
import { LoraTab } from './LoraTab'
import { ModelSources } from './ModelSources'
import { DeleteModelDialog, FeaturedModel, ModelList, SizeText } from './ModelEntries'
import { bundleBlocker, bundleDeletePlan, bundleView, downloadGroups, modelSections, parseModelsQuery, type DownloadGroup } from './logic'
import { useModelLocation, useSshHosts, type ModelLocation } from './useModelLocation'

/** Until the catalog is read, downloads are named after their own labels. */
const EMPTY_CATALOG: Pick<Catalog, 'bundles' | 'models' | 'adapters'> = { bundles: [], models: [], adapters: [] }

type Tab = 'models' | 'lora' | 'downloads'

const sharedRoleLabels: Record<ModelSourceFile['role'], string> = {
  full: '模型',
  dit: '主模型',
  text_encoder: '文本编码器',
  vae: 'VAE',
  support: '运行配置',
  lora: 'LoRA',
  control_adapter: '控制适配器',
}

function StorageRow({ location }: { location: ModelLocation }): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const settings = useApp((state) => state.settings)
  const [modelsPath, setModelsPath] = useState<string | null>(null)
  useEffect(() => {
    if (location.kind !== 'local') return
    call<AppInfo>(Ipc.appInfo)
      .then((info) => setModelsPath(info.modelsPath))
      .catch(() => undefined)
  }, [location.kind, settings?.modelsRoot])

  if (location.kind === 'remote') {
    const root = location.inventory?.root ?? location.host?.modelsRoot ?? '~/.mossstudio/models'
    return (
      <Group>
        <Row title={`模型保存在 ${location.host?.name ?? '远程主机'} 上`} description={root} />
      </Group>
    )
  }
  return (
    <Group>
      <Row title="模型文件夹" description={modelsPath ?? settings?.modelsRoot ?? '应用数据目录'}>
        {modelsPath ? (
          <IconButton
            label="打开模型文件夹"
            onClick={() =>
              void call(Ipc.openPath, { path: modelsPath }).catch((cause: unknown) =>
                toast.push(cause instanceof Error ? cause.message : String(cause), 'error'),
              )
            }
          >
            <FolderOpen className="size-4" strokeWidth={1.6} />
          </IconButton>
        ) : null}
        <Button tone="ghost" onClick={() => navigate('/settings/storage')}>
          在 设置 › 存储 中更改
        </Button>
      </Row>
    </Group>
  )
}

function ModelsTab({
  catalog,
  location,
  preferredBundleId,
}: {
  catalog: Catalog
  location: ModelLocation
  preferredBundleId: string | null
}): React.JSX.Element {
  const [deleting, setDeleting] = useState<ModelBundle | null>(null)
  const [sources, setSources] = useState<ModelSourceStatus[]>([])
  const [showIncompatible, setShowIncompatible] = useState(false)
  const settings = useApp((state) => state.settings)
  const { inventory } = useGpuInventory()
  const remote = location.kind === 'remote'
  const engineReadiness = useApp((state) => state.engineReadiness)
  const gpus = useMemo(() => generationGpus(inventory?.devices, settings), [inventory, settings])
  const cliGpus = useMemo(() => cliGpuUuids(engineReadiness), [engineReadiness])
  const [combining, setCombining] = useState<{ initial?: Partial<Record<SlotKey, string | null>> } | null>(null)
  const views = useMemo(
    () =>
      catalog.bundles
        // Scanned local files and 自己组合 are built and run on this computer.
        .filter((bundle) => !isSharedModelId(bundle.id) && (!remote || (bundle.id !== 'local-files' && !bundle.custom)))
        .map((bundle) =>
          bundleView(
            bundle,
            catalog.models,
            location.tasks,
            location.isModelInstalled,
            bundleBlocker(bundle, catalog.models, { remote, gpus, cliGpus }),
          ),
        ),
    [catalog, location.tasks, location.isModelInstalled, remote, gpus, cliGpus],
  )
  const sharedModels = catalog.models.filter((model) => model.tags.includes('shared-directory') && model.installed)
  const sharedFiles = sources.flatMap((source) => source.files)
  const availablePaths = new Set(sharedFiles.filter((file) => file.state === 'available').map((file) => file.path))
  const incompatible = [
    ...new Map(
      sharedFiles.filter((file) => file.state === 'incompatible' && !availablePaths.has(file.path)).map((file) => [file.path, file]),
    ).values(),
  ]
  const sections = modelSections(views, catalog.models, { remote, gpus, cliGpus }, preferredBundleId)
  const featuredView = sections.featured
  const deletePlan = (bundle: ModelBundle) =>
    bundleDeletePlan(bundle, catalog.bundles, catalog.models, location.isModelInstalled, location.tasks)
  const deletable = (bundle: ModelBundle): boolean =>
    !isSharedModelId(bundle.id) && (Boolean(bundle.custom) || deletePlan(bundle).ids.length > 0)
  const featuredCard = featuredView ? (
    <FeaturedModel
      view={featuredView}
      models={catalog.models}
      location={location}
      pick={sections.pick ?? undefined}
      deletable={deletable(featuredView.bundle)}
      onDelete={setDeleting}
    />
  ) : null
  const featuredCertified = Boolean(featuredView?.bundle.certified)

  // 自己组合 stays at hand: it pairs with imported files, and its slots offer the ones the engine recognised.
  const combine =
    location.kind === 'local' ? (
      <Button tone="secondary" onClick={() => setCombining({})}>
        <Plus className="size-4" strokeWidth={1.6} />
        自己组合
      </Button>
    ) : null

  return (
    <div className="flex flex-col gap-8">
      {location.kind === 'remote' && location.scanError ? (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={location.rescan}>
              重试
            </Button>
          }
        >
          读不到 {location.host?.name ?? '远程主机'} 上的模型：{location.scanError}。检查这台主机是否在线，然后重试。
        </Notice>
      ) : null}

      {location.ready && (sections.mine.length || combine) ? (
        <Section title="我的模型" actions={combine}>
          {sections.mine.length ? (
            <ModelList
              views={sections.mine}
              models={catalog.models}
              location={location}
              highlightId={preferredBundleId}
              deletable={deletable}
              onDelete={setDeleting}
            />
          ) : (
            <Group>
              <EmptyState size="section" title="还没有自己的模型" />
            </Group>
          )}
        </Section>
      ) : null}

      {location.kind === 'local' ? (
        <>
          <Section title="共享模型目录">
            <ModelSources onSources={setSources} />
          </Section>
          {sources.length || sharedModels.length ? (
            <Section title="可用模型">
              {sharedModels.length ? (
                <Group>
                  {sharedModels.map((model) => (
                    <Row key={model.id} title={model.name} description={sharedRoleLabels[model.role]}>
                      <SizeText bytes={model.installedBytes || model.sizeBytes} />
                    </Row>
                  ))}
                </Group>
              ) : (
                <EmptyState
                  size="section"
                  title={sources.some((source) => source.pending > 0) ? '模型文件还在等待检查' : '已接入的目录里没有能用的模型'}
                />
              )}
              {incompatible.length ? (
                <Advanced
                  title="不兼容的模型和 LoRA"
                  summary={incompatible.length + ' 项'}
                  open={showIncompatible}
                  onOpenChange={setShowIncompatible}
                >
                  {showIncompatible ? (
                    <Group className="max-h-96 overflow-y-auto">
                      {incompatible.map((file) => (
                        <Row key={file.path} title={file.name} description={file.reason ?? sharedRoleLabels[file.role]}>
                          <SizeText bytes={file.size} />
                        </Row>
                      ))}
                    </Group>
                  ) : null}
                </Advanced>
              ) : null}
            </Section>
          ) : null}
        </>
      ) : null}

      {!location.ready ? (
        location.scanning ? (
          <LoadingRow label={`正在查看 ${location.host?.name ?? '远程主机'} 上的模型…`} />
        ) : null
      ) : featuredView ? (
        <>
          {featuredCertified ? null : featuredCard}
          {featuredCertified || sections.certified.length ? (
            <Section title="推荐模型" description="引擎验证过的模型，下载后就能用">
              {featuredCertified ? featuredCard : null}
              {sections.certified.length ? (
                <ModelList
                  views={sections.certified}
                  models={catalog.models}
                  location={location}
                  highlightId={preferredBundleId}
                  deletable={deletable}
                  onDelete={setDeleting}
                />
              ) : null}
            </Section>
          ) : null}
        </>
      ) : (
        <Group>
          <EmptyState
            size="section"
            icon={<Package className="size-6" strokeWidth={1.6} />}
            title="还没有可用的模型列表"
            description="刷新一下；如果仍然为空，检查网络后再试。"
          />
        </Group>
      )}

      {location.ready && sections.others.length ? (
        <Section title="其他模型" description="引擎没有验证过，不保证能正常出图">
          <ModelList
            views={sections.others}
            models={catalog.models}
            location={location}
            highlightId={preferredBundleId}
            deletable={deletable}
            onDelete={setDeleting}
          />
        </Section>
      ) : null}

      {location.kind === 'local' ? <ControlAdaptersSection /> : null}

      <Section title="存储位置">
        <StorageRow location={location} />
      </Section>

      <Advanced summary={location.kind === 'local' ? '各部件的文件夹、没有用到的文件' : '主机上的模型文件夹'}>
        {location.ready ? (
          <AdvancedPanel catalog={catalog} location={location} />
        ) : (
          <p className="px-3.5 py-2 text-caption text-ink-2">读到这台主机上的模型后才能管理部件。</p>
        )}
      </Advanced>

      {combining ? (
        <CombinationDialog open catalog={catalog} location={location} initial={combining.initial} onClose={() => setCombining(null)} />
      ) : null}

      <DeleteModelDialog
        bundle={deleting}
        bundles={catalog.bundles}
        models={catalog.models}
        location={location}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

function DownloadsTab({ catalog, location }: { catalog: Catalog | null; location: ModelLocation }): React.JSX.Element {
  const groups = downloadGroups(location.tasks, catalog ?? EMPTY_CATALOG)
  // A whole model resumes the way its 继续 on the 模型 tab does: every missing part again, from where it stopped.
  const resume = (group: DownloadGroup): Promise<unknown> =>
    group.bundle
      ? location.downloadBundle(group.bundle)
      : Promise.all(group.open.filter((task) => task.state === 'paused' || task.state === 'error').map(location.resume))
  return (
    <div className="flex flex-col gap-3">
      {location.kind === 'remote' ? (
        <div className="flex items-center justify-between gap-4 px-1">
          <p className="text-caption text-ink-2">
            关闭 MossStudio 后，{location.host?.name ?? '远程主机'} 上的下载仍会继续，重新连接后显示最新进度。
          </p>
          <IconButton
            label="刷新下载进度"
            onClick={() => location.host && void call(Ipc.remoteDownloadsRefresh, { hostId: location.host.id }).catch(() => undefined)}
          >
            <RefreshCw className="size-4" strokeWidth={1.6} />
          </IconButton>
        </div>
      ) : null}
      {groups.length ? (
        <DownloadQueue groups={groups} onPause={location.pause} onResume={resume} onCancel={location.cancel} />
      ) : (
        <Group>
          <EmptyState
            size="section"
            icon={<Download className="size-6" strokeWidth={1.6} />}
            title="没有进行中的下载"
            description="开始下载模型或 LoRA 后，进度会显示在这里。"
          />
        </Group>
      )}
    </div>
  )
}

/** 模型: whole models first, LoRA and downloads in their own tabs, parts under 高级. */
export function ModelsPage(): React.JSX.Element {
  const toast = useToast()
  const routeLocation = useLocation()
  const catalog = useApp((state) => state.catalog)
  const settings = useApp((state) => state.settings)
  const refreshCatalog = useApp((state) => state.refreshCatalog)
  const remoteEnabled = Boolean(settings?.remoteHostsEnabled)
  const hosts = useSshHosts(remoteEnabled)
  const [locationId, setLocationId] = useState('local')
  const [tab, setTab] = useState<Tab>('models')
  const [preferredBundleId, setPreferredBundleId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Deep links from first run and elsewhere: ?bundle=…&component=…&hostId=…&tab=…
  useEffect(() => {
    const query = parseModelsQuery(routeLocation.search)
    if (query.bundleId) setPreferredBundleId(query.bundleId)
    if (query.tab) setTab(query.tab)
    else if (query.bundleId || query.component) setTab('models')
    if (query.hostId) setLocationId(query.hostId)
  }, [routeLocation.key, routeLocation.search])

  useEffect(() => {
    void refreshCatalog()
  }, [refreshCatalog])

  const host = remoteEnabled ? (hosts.find((item) => item.id === locationId) ?? null) : null
  const location = useModelLocation(host)
  // One per model, as the 下载 tab lists them.
  const downloadCount = downloadGroups(location.tasks, catalog ?? EMPTY_CATALOG).length

  const locationOptions = [{ value: 'local', label: '本机' }, ...hosts.map((item) => ({ value: item.id, label: item.name }))]
  const locationPicker =
    remoteEnabled && hosts.length > 0 ? (
      locationOptions.length <= 4 ? (
        <Segmented label="模型所在的电脑" value={host ? host.id : 'local'} options={locationOptions} onChange={setLocationId} />
      ) : (
        <Select
          aria-label="模型所在的电脑"
          value={host ? host.id : 'local'}
          options={locationOptions}
          onValueChange={setLocationId}
          className="w-48"
        />
      )
    ) : null

  const pickImport = useModelImport((state) => state.pick)
  // One way in for files on this computer: the engine says what each one is.
  const importButton =
    location.kind === 'local' ? (
      <Popover
        align="end"
        label="导入模型"
        trigger={(menu) => (
          <Button tone="primary" onClick={menu.toggle} aria-expanded={menu['aria-expanded']} aria-haspopup="menu">
            导入模型
            <ChevronDown className="size-4" strokeWidth={1.6} />
          </Button>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              onSelect={() => {
                close()
                void pickImport('files').catch((cause: unknown) =>
                  toast.push(cause instanceof Error ? cause.message : String(cause), 'error'),
                )
              }}
            >
              选择文件…
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close()
                void pickImport('folder').catch((cause: unknown) =>
                  toast.push(cause instanceof Error ? cause.message : String(cause), 'error'),
                )
              }}
            >
              选择文件夹…
            </MenuItem>
          </>
        )}
      </Popover>
    ) : null

  async function refresh(): Promise<void> {
    setRefreshing(true)
    try {
      await refreshCatalog()
      location.rescan()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <PageScroll>
      <PageHeader
        title="模型"
        description="管理生成图片用的模型和 LoRA。"
        actions={
          <>
            {locationPicker}
            <IconButton label="刷新" disabled={refreshing} onClick={() => void refresh()}>
              <RefreshCw className={refreshing ? 'size-4 animate-spin' : 'size-4'} strokeWidth={1.6} />
            </IconButton>
            {importButton}
          </>
        }
      />

      <Tabs
        label="模型页面"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'models', label: '模型' },
          { value: 'lora', label: 'LoRA' },
          { value: 'downloads', label: '下载', count: downloadCount },
        ]}
      />

      {!catalog ? (
        <LoadingRow label="正在读取模型列表…" />
      ) : tab === 'models' ? (
        <ModelsTab catalog={catalog} location={location} preferredBundleId={preferredBundleId} />
      ) : tab === 'lora' ? (
        <LoraTab catalog={catalog} location={location} />
      ) : (
        <DownloadsTab catalog={catalog} location={location} />
      )}
    </PageScroll>
  )
}
