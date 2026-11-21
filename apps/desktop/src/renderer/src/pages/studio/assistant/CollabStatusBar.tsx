import { StatusDot } from '../../../components/ui'

export type CollabActivity = 'idle' | 'replying' | 'tool' | 'offline'

const ACTIVITY_LABELS: Record<CollabActivity, string> = {
  idle: '空闲',
  replying: '回复中…',
  tool: '执行工具中…',
  offline: '未连接',
}

/** The last folder name of a path, for a status line too narrow for the whole path. */
export function folderTail(path: string | undefined): string {
  if (!path) return ''
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? path
}

/** One quiet line at the foot of the panel: who, where, which model, how many tools, and what it is doing. */
export function CollabStatusBar({
  backendLabel,
  connected,
  cwd,
  model,
  mcpToolCount,
  activity,
}: {
  backendLabel: string
  connected: boolean
  cwd?: string
  model?: string
  mcpToolCount: number | null
  activity: CollabActivity
}): React.JSX.Element {
  const state = connected ? activity : 'offline'
  const parts = [
    `${backendLabel} · ${connected ? '已连接' : '未连接'}`,
    cwd ? `工作区 ${cwd}` : '',
    model ? `模型 ${model}` : '',
    mcpToolCount === null ? 'MCP 没有运行' : `MCP 工具 ${mcpToolCount} 个`,
    ACTIVITY_LABELS[state],
  ].filter(Boolean)
  return (
    <div
      role="status"
      aria-label="协同状态"
      title={parts.join('\n')}
      data-collab-status
      data-activity={state}
      className="flex h-6 min-w-0 shrink-0 items-center gap-2 overflow-hidden rounded-md bg-well px-2 text-micro text-ink-2"
    >
      <span className="flex min-w-0 shrink items-center gap-1">
        <StatusDot status={connected ? 'ok' : 'unknown'} />
        <span className="truncate text-ink">{backendLabel}</span>
      </span>
      {cwd ? <span className="min-w-0 shrink-[2] truncate">{folderTail(cwd)}</span> : null}
      {model ? <span className="min-w-0 shrink-[2] truncate">{model}</span> : null}
      <span className="shrink-0">MCP · {mcpToolCount ?? '—'}</span>
      <span className="ml-auto shrink-0">{ACTIVITY_LABELS[state]}</span>
    </div>
  )
}
