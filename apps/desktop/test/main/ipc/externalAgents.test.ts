import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ipcMain } from '@test/mocks/electron'
import { Ipc } from '@shared/channels'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { paths } from '@main/lib/paths'
import { DEFAULT_SETTINGS, updateSettings } from '@main/services/settings'
import { getActiveMcpServer, stopMcpServer } from '@main/mcp'
import { registerIpc, syncExternalAgents } from '@main/ipc'

registerIpc()
useTempDataRoot()

const EXTERNAL_CHANNELS: Record<string, unknown> = {
  [Ipc.agentHubBackends]: undefined,
  [Ipc.agentHubConnect]: { backendId: 'codex-acp' },
  [Ipc.agentHubApprovals]: undefined,
  [Ipc.capabilitiesList]: undefined,
  [Ipc.capabilitiesExecute]: { name: 'system.guide.read' },
  [Ipc.capabilitiesAudit]: undefined,
  [Ipc.mcpClientsStatus]: undefined,
  [Ipc.mcpClientInstall]: { clientId: 'codex' },
  [Ipc.mcpInfo]: undefined,
  [Ipc.mcpSetProfile]: { profile: 'compact' },
}

const invoke = (channel: string, payload?: unknown) =>
  ipcMain.handlers.get(channel)!({ sender: { isDestroyed: () => false, send: () => undefined } }, payload) as Promise<{
    ok: boolean
    error?: { code: string }
  }>

beforeEach(() => {
  updateSettings({ externalAgentsEnabled: false })
})
afterEach(() => stopMcpServer())

describe('设置 › 功能 › 外部 Agent', () => {
  it('is off for a new install and for a settings file written before the switch existed', () => {
    expect(DEFAULT_SETTINGS.externalAgentsEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.workerHostsEnabled).toBe(false)
  })

  it('refuses every channel of the feature while it is off, without starting anything', async () => {
    for (const [channel, payload] of Object.entries(EXTERNAL_CHANNELS)) {
      const result = await invoke(channel, payload)
      expect(result, channel).toMatchObject({ ok: false, error: { code: 'E_FEATURE_OFF' } })
    }
    expect(getActiveMcpServer()).toBeNull()
    expect(existsSync(paths.mcpDiscovery())).toBe(false)
    expect(existsSync(paths.mcpDir())).toBe(false)
  })

  it('starts the MCP server and its discovery file when turned on, and removes both when turned off', async () => {
    await syncExternalAgents({ ...DEFAULT_SETTINGS })
    expect(getActiveMcpServer()).toBeNull()
    expect(existsSync(paths.mcpDiscovery())).toBe(false)

    const on = updateSettings({ externalAgentsEnabled: true })
    await syncExternalAgents(on)
    expect(getActiveMcpServer()).not.toBeNull()
    expect(existsSync(paths.mcpDiscovery())).toBe(true)
    expect(await invoke(Ipc.mcpInfo, {})).toMatchObject({ ok: true })

    await syncExternalAgents(updateSettings({ externalAgentsEnabled: false }))
    expect(getActiveMcpServer()).toBeNull()
    expect(existsSync(paths.mcpDiscovery())).toBe(false)
  })
})
