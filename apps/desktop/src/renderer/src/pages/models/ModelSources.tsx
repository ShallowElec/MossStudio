import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Events, Ipc } from '@shared/channels'
import type { ModelSource, ModelSourcesView } from '@shared/types'
import { Notice } from '../../components/common/Notice'
import { MenuItem, Popover } from '../../components/common/Popover'
import { Button, EmptyState, Group, LoadingRow, Row } from '../../components/ui'
import { call, onEvent } from '../../lib/api'
import { modelSourceKindLabels as kindLabels, runningServicesText } from './logic'

type SourcesChannel =
  typeof Ipc.modelSourcesList | typeof Ipc.modelSourcesRefresh | typeof Ipc.modelSourcesAdd | typeof Ipc.modelSourcesRemove
interface SourcesInput {
  path?: string
  kind?: ModelSource['kind']
  id?: string
}

export function ModelSources({
  reload,
  onSources,
}: {
  reload?: string
  onSources?: (sources: ModelSourcesView['sources']) => void
}): React.JSX.Element {
  const { pathname } = useLocation()
  const [view, setView] = useState<ModelSourcesView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const last = useRef<{ channel: SourcesChannel; input?: SourcesInput }>({ channel: Ipc.modelSourcesList })
  const mounted = useRef(true)
  const requestSeq = useRef(0)
  const mutating = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(
    async (channel: SourcesChannel, input?: SourcesInput): Promise<void> => {
      const seq = ++requestSeq.current
      const isMutation = channel !== Ipc.modelSourcesList
      if (isMutation) mutating.current = true
      last.current = { channel, input }
      setBusy(true)
      setError(null)
      try {
        const result = await call<ModelSourcesView>(channel, input)
        if (!mounted.current || seq !== requestSeq.current) return
        setView(result)
        onSources?.(result.sources)
      } catch (cause) {
        if (!mounted.current || seq !== requestSeq.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (isMutation) mutating.current = false
        if (mounted.current && seq === requestSeq.current) setBusy(false)
      }
    },
    [onSources],
  )

  const refreshQuiet = useCallback(async (): Promise<void> => {
    // Mutating actions already return the updated view after emitting Events.modelsChanged (and scan includes running services).
    if (mutating.current) return
    const seq = ++requestSeq.current
    try {
      const result = await call<ModelSourcesView>(Ipc.modelSourcesList)
      if (!mounted.current || seq !== requestSeq.current) return
      setView(result)
      onSources?.(result.sources)
    } catch {
      // Background sync failure stays quiet; manual actions report errors.
    }
  }, [onSources])

  useEffect(() => {
    if (pathname === '/models' || pathname === '/setup') void run(Ipc.modelSourcesList)
  }, [run, reload, pathname])

  useEffect(() => {
    if (pathname !== '/models' && pathname !== '/setup') return
    return onEvent<{ reason?: string } | undefined>(Events.modelsChanged, (payload) => {
      const reason = payload?.reason
      if (reason === 'shared-sources' || reason === 'settings') void refreshQuiet()
    })
  }, [pathname, refreshQuiet])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Popover
          label="添加来源"
          trigger={(menu) => (
            <Button
              tone="secondary"
              disabled={busy}
              onClick={menu.toggle}
              aria-expanded={menu['aria-expanded']}
              aria-controls={menu['aria-controls']}
              aria-haspopup={menu['aria-haspopup']}
            >
              添加来源
            </Button>
          )}
        >
          {(close) =>
            (Object.keys(kindLabels) as Array<ModelSource['kind']>).map((kind) => (
              <MenuItem
                key={kind}
                onSelect={() => {
                  close()
                  void run(Ipc.modelSourcesAdd, { kind })
                }}
              >
                {kindLabels[kind]}
              </MenuItem>
            ))
          }
        </Popover>
        <Button tone="ghost" disabled={busy} onClick={() => void run(Ipc.modelSourcesRefresh)}>
          自动扫描
        </Button>
      </div>
      {busy ? <LoadingRow label="正在检查模型目录…" /> : null}
      {error ? (
        <Notice
          tone="danger"
          action={
            <Button size="xs" tone="secondary" disabled={busy} onClick={() => void run(last.current.channel, last.current.input)}>
              重试
            </Button>
          }
        >
          {error}
        </Notice>
      ) : null}
      {view?.services ? <Notice>{runningServicesText(view.services)}</Notice> : null}
      {view?.sources.length ? (
        <Group>
          {view.sources.map((source) => (
            <Row
              key={source.id}
              title={kindLabels[source.kind]}
              description={
                <div className="flex flex-col gap-1 [overflow-wrap:anywhere]">
                  <span>{source.path}</span>
                  {source.issues.map((issue) => (
                    <span key={issue} className="text-warn">
                      {issue}
                    </span>
                  ))}
                </div>
              }
            >
              <Button tone="ghost" disabled={busy} onClick={() => void run(Ipc.modelSourcesAdd, { id: source.id, kind: source.kind })}>
                更换路径
              </Button>
              <Button tone="ghost" disabled={busy} onClick={() => void run(Ipc.modelSourcesRemove, { id: source.id })}>
                移除来源
              </Button>
            </Row>
          ))}
        </Group>
      ) : null}
      {view?.suggestions.length ? (
        <Group>
          {view.suggestions.map((source) => (
            <Row key={source.id} title={'发现 ' + kindLabels[source.kind]} description={source.path}>
              <Button
                tone="secondary"
                disabled={busy}
                onClick={() => void run(Ipc.modelSourcesAdd, { path: source.path, kind: source.kind })}
              >
                接入
              </Button>
            </Row>
          ))}
        </Group>
      ) : null}
      {view && !view.sources.length && !view.suggestions.length ? <EmptyState size="section" title="还没有接入模型目录" /> : null}
    </div>
  )
}
