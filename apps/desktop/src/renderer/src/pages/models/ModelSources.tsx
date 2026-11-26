import { AlertTriangle, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Ipc } from '@shared/channels'
import type { ModelSource, ModelSourceIssue, ModelSourcesView } from '@shared/types'
import { Notice } from '../../components/common/Notice'
import { MenuItem, Popover } from '../../components/common/Popover'
import { Button, EmptyState, Group, LoadingRow, Row, cn } from '../../components/ui'
import { call } from '../../lib/api'
import {
  clearDismissedForSource,
  modelSourceKindLabels as kindLabels,
  partitionSourceIssues,
  readDismissedSourceIssues,
  runningServicesText,
  sourceIssueKey,
  writeDismissedSourceIssues,
} from './logic'

type SourcesChannel =
  typeof Ipc.modelSourcesList | typeof Ipc.modelSourcesRefresh | typeof Ipc.modelSourcesAdd | typeof Ipc.modelSourcesRemove
interface SourcesInput {
  path?: string
  kind?: ModelSource['kind']
  id?: string
}

function SourceIssueCard({
  issue,
  action,
  onDismiss,
}: {
  issue: ModelSourceIssue
  action?: React.ReactNode
  onDismiss: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const details = issue.details ?? []
  return (
    <div
      role="status"
      data-source-issue={issue.id}
      className="flex flex-col gap-1 rounded-lg bg-warn-soft px-3 py-2 text-caption text-ink [overflow-wrap:anywhere]"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" strokeWidth={1.6} aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-ink">{issue.message}</span>
          {issue.origin ? <span className="text-ink-2">来源：{issue.origin}</span> : null}
          {issue.suggestion ? <span className="text-ink-2">建议：{issue.suggestion}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {action}
          <Button size="xs" tone="ghost" onClick={onDismiss}>
            忽略
          </Button>
        </div>
      </div>
      {details.length ? (
        <div className="pl-5">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-caption text-ink-2 transition-colors hover:bg-well hover:text-ink"
          >
            <ChevronRight
              className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
              strokeWidth={1.6}
              aria-hidden="true"
            />
            <span>{expanded ? '收起涉及的目录' : `查看涉及的 ${details.length} 个目录`}</span>
          </button>
          {expanded ? (
            <ul className="mt-1 flex flex-col gap-0.5 pl-4 font-mono text-caption text-ink-2">
              {details.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function ModelSources({
  reload,
  onSources,
}: {
  reload?: string
  onSources?: (sources: ModelSourcesView['sources']) => void
}): React.JSX.Element {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [view, setView] = useState<ModelSourcesView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissedIssues, setDismissedIssues] = useState<Set<string>>(() => readDismissedSourceIssues())
  const last = useRef<{ channel: SourcesChannel; input?: SourcesInput }>({ channel: Ipc.modelSourcesList })

  const updateDismissed = useCallback((mutate: (current: Set<string>) => Set<string>) => {
    setDismissedIssues((current) => {
      const next = mutate(current)
      writeDismissedSourceIssues(next)
      return next
    })
  }, [])

  const dismissIssue = useCallback(
    (sourceId: string, issueId: string) => {
      updateDismissed((current) => {
        const next = new Set(current)
        next.add(sourceIssueKey(sourceId, issueId))
        return next
      })
    },
    [updateDismissed],
  )

  const restoreIssues = useCallback(
    (sourceId: string) => {
      updateDismissed((current) => clearDismissedForSource(current, sourceId))
    },
    [updateDismissed],
  )

  const run = useCallback(
    async (channel: SourcesChannel, input?: SourcesInput): Promise<void> => {
      last.current = { channel, input }
      setBusy(true)
      setError(null)
      try {
        const result = await call<ModelSourcesView>(channel, input)
        if (channel === Ipc.modelSourcesRemove && input?.id) {
          const removedId = input.id
          updateDismissed((current) => clearDismissedForSource(current, removedId))
        }
        setView(result)
        onSources?.(result.sources)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [onSources, updateDismissed],
  )

  useEffect(() => {
    if (pathname === '/models' || pathname === '/setup') void run(Ipc.modelSourcesList)
  }, [run, reload, pathname])

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
          {view.sources.map((source) => {
            const { visible, dismissedCount } = partitionSourceIssues(source, dismissedIssues)
            return (
              <div key={source.id} className="flex flex-col gap-1.5">
                <Row title={kindLabels[source.kind]} description={source.path}>
                  <Button tone="ghost" disabled={busy} onClick={() => void run(Ipc.modelSourcesAdd, { id: source.id, kind: source.kind })}>
                    更换路径
                  </Button>
                  <Button tone="ghost" disabled={busy} onClick={() => void run(Ipc.modelSourcesRemove, { id: source.id })}>
                    移除来源
                  </Button>
                </Row>
                {visible.length || dismissedCount ? (
                  <div className="flex flex-col gap-1.5 px-3.5 pb-2">
                    {visible.map((issue) => (
                      <SourceIssueCard
                        key={issue.id}
                        issue={issue}
                        action={
                          pathname === '/models' && issue.id.startsWith('overlap:') ? (
                            <Button size="xs" tone="ghost" onClick={() => navigate('/settings/storage')}>
                              前往存储设置
                            </Button>
                          ) : undefined
                        }
                        onDismiss={() => dismissIssue(source.id, issue.id)}
                      />
                    ))}
                    {dismissedCount ? (
                      <div className="flex items-center gap-2 text-caption text-ink-2">
                        <span>已忽略 {dismissedCount} 条提示</span>
                        <Button size="xs" tone="ghost" onClick={() => restoreIssues(source.id)}>
                          显示
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
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
