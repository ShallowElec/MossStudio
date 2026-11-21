import type { Settings } from '@shared/types'
import { codedError } from './lib/codedError'
import { getSettings } from './services/settings'

/** Whether 设置 › 功能 › 外部 Agent is on: the MCP server, the client registration, the 协同 panel and its approvals. */
export function externalAgentsOn(settings: Pick<Settings, 'externalAgentsEnabled'> = getSettings()): boolean {
  return settings.externalAgentsEnabled === true
}

/** Refuses a request of the 外部 Agent feature while it is off. */
export function assertExternalAgentsOn(): void {
  if (!externalAgentsOn()) throw codedError('E_FEATURE_OFF', '外部 Agent 还没有打开，请先在 设置 › 功能 里打开')
}
