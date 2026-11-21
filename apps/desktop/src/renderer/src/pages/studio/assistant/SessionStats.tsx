import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn, FieldLabel, IconButton, ProgressBar, StatusDot } from '../../../components/ui'
import { relative } from '../../../lib/format'
import { capabilityLabel } from './collabContext'
import type { AgentMessage, CollabSessionStats, AuditRow, CollabClient } from './collabClient'

const AUDIT_LIMIT = 8
const numberFormat = new Intl.NumberFormat('zh-CN')

export function formatCount(value: number): string {
  return numberFormat.format(Math.round(value))
}

/** Turns and size of the conversation; Agent figures win over what the panel can count itself. */
export function conversationFigures(
  messages: readonly AgentMessage[],
  stats: CollabSessionStats | null,
): { messages: number; turns: number; usage: { used: number; limit?: number; estimated: boolean } } {
  const turns = stats?.turnCount ?? messages.filter((message) => message.role === 'user').length
  const usage = stats?.tokenUsage
  const used =
    usage?.total ?? (usage?.input !== undefined || usage?.output !== undefined ? (usage?.input ?? 0) + (usage?.output ?? 0) : undefined)
  if (used !== undefined)
    return { messages: stats?.messageCount ?? messages.length, turns, usage: { used, limit: usage?.limit, estimated: false } }
  const chars = messages.reduce((sum, message) => sum + message.text.length, 0)
  return { messages: stats?.messageCount ?? messages.length, turns, usage: { used: chars, estimated: true } }
}

function Figure({ label, value, title }: { label: string; value: string; title?: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-panel px-2 py-1.5" title={title ?? value}>
      <span className="truncate text-micro text-ink-2">{label}</span>
      <span className="tabular truncate text-caption text-ink">{value}</span>
    </div>
  )
}

/** What this session is running on, how big it is, and the last tool calls (操作留痕). */
export function SessionStatsPanel({
  client,
  backendId,
  backendLabel,
  sessionId,
  messages,
  model,
  mcpToolCount,
}: {
  client: CollabClient
  backendId: string
  backendLabel: string
  sessionId: string
  messages: readonly AgentMessage[]
  model?: string
  mcpToolCount: number | null
}): React.JSX.Element {
  const [stats, setStats] = useState<CollabSessionStats | null>(null)
  const [audit, setAudit] = useState<AuditRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const version = ++generation.current
    setLoading(true)
    const [nextStats, nextAudit] = await Promise.all([client.sessionStats(backendId, sessionId), client.audit(AUDIT_LIMIT)])
    if (generation.current !== version) return
    setStats(nextStats)
    setAudit(nextAudit)
    setLoading(false)
  }, [client, backendId, sessionId])

  useEffect(() => {
    // The ref object itself, held for the cleanup: a reply still on its way is dropped.
    const gen = generation
    void load()
    return () => {
      gen.current++
    }
  }, [load])

  const figures = conversationFigures(messages, stats)
  const { usage } = figures
  const shownModel = stats?.model ?? model
  const percent = usage.limit ? Math.min(100, (usage.used / usage.limit) * 100) : null

  return (
    <section className="flex shrink-0 flex-col gap-2 rounded-lg bg-well p-2.5" aria-label="会话数据" data-session-stats>
      <div className="flex items-center gap-1">
        <FieldLabel as="h3" className="min-w-0 flex-1">
          会话数据
        </FieldLabel>
        <IconButton label="刷新会话数据" className="size-6" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} strokeWidth={1.6} />
        </IconButton>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Figure label="后端" value={backendLabel} />
        <Figure label="模型" value={shownModel ? `${shownModel}${stats?.provider ? ` · ${stats.provider}` : ''}` : '未知'} />
        <Figure label="消息 / 轮次" value={`${formatCount(figures.messages)} / ${formatCount(figures.turns)}`} />
        <Figure label="MCP 工具" value={mcpToolCount === null ? '没有运行' : `${formatCount(mcpToolCount)} 个`} />
      </div>
      <div className="flex flex-col gap-1" data-session-usage>
        <FieldLabel
          value={
            usage.estimated
              ? `约 ${formatCount(usage.used)} 字`
              : `${formatCount(usage.used)}${usage.limit ? ` / ${formatCount(usage.limit)}` : ''}`
          }
        >
          {usage.estimated ? '上下文（按字数估算）' : '上下文用量'}
        </FieldLabel>
        {percent !== null ? <ProgressBar value={percent} tone={percent > 85 ? 'danger' : 'accent'} label="上下文用量" /> : null}
      </div>
      <div className="flex flex-col gap-1">
        <FieldLabel value={audit ? `${audit.length} 条` : undefined}>最近工具调用</FieldLabel>
        {audit === null ? null : audit.length === 0 ? (
          <p className="text-caption text-ink-2">还没有工具调用记录</p>
        ) : (
          <ul className="flex flex-col gap-0.5" data-audit-list>
            {audit.map((row) => (
              <li
                key={row.id}
                className="flex min-w-0 items-center gap-1.5 text-caption"
                title={[row.actionId, row.summary, row.error].filter(Boolean).join(' · ')}
              >
                <StatusDot status={row.ok ? 'ok' : 'error'} />
                <span className="min-w-0 flex-1 truncate text-ink">{row.summary || capabilityLabel(row.actionId)}</span>
                <span className="tabular shrink-0 text-micro text-ink-2">{formatCount(row.durationMs)} ms</span>
                <span className="shrink-0 text-micro text-ink-2">{relative(row.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
