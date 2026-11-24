import { APPROVAL_WAIT_MS } from './agentHub'

/** Seconds a client waits for one tool call: longer than an approval waits, so a late approval never runs an abandoned call. */
export const CLIENT_TOOL_TIMEOUT_SEC = Math.ceil(APPROVAL_WAIT_MS / 1000) + 60

export type ManagedClientId = 'codex' | 'claude-code'
export type McpClientId = ManagedClientId | 'dsh'
export const CLIENT_STATES = [
  'not_found',
  'not_configured',
  'configured',
  'conflict',
  'needs_refresh',
  'custom_policy',
  'unsupported',
  'unknown',
  'detected',
] as const
export interface McpClientStatus {
  id: McpClientId
  label: string
  configPath: string
  state: (typeof CLIENT_STATES)[number]
  installMode: 'auto' | 'copy-only'
  detail: string
}
export interface BridgeLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}
