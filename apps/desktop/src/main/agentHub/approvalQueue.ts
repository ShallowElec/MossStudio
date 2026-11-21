import { randomUUID } from 'node:crypto'
import { Events } from '@shared/channels'
import type { CapabilityApprovalRequest, PendingCapabilityApproval } from '@shared/agentHub'

/** How long a request waits for the person before it counts as rejected. MCP clients get a tool timeout longer than this. */
export const APPROVAL_WAIT_MS = 120_000

/** Requests one caller may have waiting at once; more are rejected at once instead of piling up. */
export const MAX_PENDING_PER_SOURCE = 5

export function createCapabilityApprovalQueue(options: {
  emit: (channel: string, payload: { pending: PendingCapabilityApproval[] }) => void
  timeoutMs?: number
}) {
  const pending = new Map<
    string,
    { info: PendingCapabilityApproval; settle: (approved: boolean) => void; timer: ReturnType<typeof setTimeout>; release: () => void }
  >()
  const listPending = (): PendingCapabilityApproval[] => [...pending.values()].map(({ info }) => ({ ...info }))
  const broadcast = () => options.emit(Events.capabilityApproval, { pending: listPending() })
  const resolve = (id: string, decision: 'approve' | 'reject'): boolean => {
    const item = pending.get(id)
    if (!item) return false
    pending.delete(id)
    clearTimeout(item.timer)
    item.release()
    item.settle(decision === 'approve')
    broadcast()
    return true
  }
  return {
    listPending,
    resolve,
    /** Asks the person; false on reject, timeout, a full queue, or when `signal` aborts (the Agent went away). */
    requestApproval(info: CapabilityApprovalRequest, signal?: AbortSignal): Promise<boolean> {
      if (signal?.aborted) return Promise.resolve(false)
      const waiting = [...pending.values()].filter((item) => item.info.source === info.source).length
      if (waiting >= MAX_PENDING_PER_SOURCE) return Promise.resolve(false)
      const id = randomUUID()
      return new Promise<boolean>((settle) => {
        const timer = setTimeout(() => resolve(id, 'reject'), options.timeoutMs ?? APPROVAL_WAIT_MS)
        timer.unref?.()
        const abort = (): void => void resolve(id, 'reject')
        signal?.addEventListener('abort', abort, { once: true })
        pending.set(id, {
          info: { ...info, id, createdAt: new Date().toISOString() },
          settle,
          timer,
          release: () => signal?.removeEventListener('abort', abort),
        })
        broadcast()
      })
    },
    clear(): void {
      for (const item of pending.values()) {
        clearTimeout(item.timer)
        item.release()
        item.settle(false)
      }
      pending.clear()
      broadcast()
    },
  }
}
