import { BrowserWindow } from 'electron'
import { Events } from '@shared/channels'
import type { AgentHubEvent } from '@shared/agentHub'
import type { MainCapabilityDispatcher } from '../capabilities/dispatcher'
import { emit } from '../lib/events'
import { getMcpServerState } from '../mcp'
import { listCapabilityAudit } from '../capabilities'
import { createCapabilityApprovalQueue } from './approvalQueue'
import { createAcpDriver } from './acpDriver'
import { createAgentHub } from './hub'

export const capabilityApprovalQueue = createCapabilityApprovalQueue({ emit })
const agentEvent = (event: AgentHubEvent) => emit(Events.agentHubEvent, event)
export const agentHub = createAgentHub(
  [
    createAcpDriver({ id: 'codex-acp', label: 'Codex ACP', command: 'codex-acp', emit: agentEvent }),
    createAcpDriver({ id: 'custom-acp', label: '自定义 ACP', emit: agentEvent }),
  ],
  async () => ({
    activeMcpTools: getMcpServerState().toolCount,
    recentToolCalls: (await listCapabilityAudit({ limit: 50, source: 'external-agent' })).length,
  }),
)
export function attachCapabilityApproval(dispatcher: MainCapabilityDispatcher): void {
  dispatcher.requestApproval = (request, signal) => {
    const open = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
    return open ? capabilityApprovalQueue.requestApproval(request, signal) : Promise.resolve(false)
  }
}
export async function stopAgentHub(): Promise<void> {
  capabilityApprovalQueue.clear()
  await agentHub.shutdown()
}
