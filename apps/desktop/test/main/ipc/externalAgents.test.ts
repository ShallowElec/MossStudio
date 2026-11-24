import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from '@test/mocks/electron'
import { Ipc } from '@shared/channels'
import { useTempDataRoot } from '@test/helpers/tempDir'
import * as discovery from '@main/lib/cliDiscovery'
import { paths } from '@main/lib/paths'
import { DEFAULT_SETTINGS, updateSettings } from '@main/services/settings'
import { getActiveMcpServer, stopMcpServer } from '@main/mcp'
import { flushCapabilityAudit } from '@main/capabilities/audit'
import { registerIpc, syncExternalAgents } from '@main/ipc'

registerIpc()
useTempDataRoot()

const EXTERNAL_CHANNELS: Record<string, unknown> = {
  [Ipc.agentHubBackends]: undefined,
  [Ipc.agentHubConnect]: { backendId: 'codex-acp' },
  [Ipc.agentHubProjects]: { backendId: 'dsh-desktop' },
  [Ipc.agentHubApprovals]: undefined,
  [Ipc.capabilitiesList]: undefined,
  [Ipc.capabilitiesExecute]: { name: 'system.guide.read' },
  [Ipc.capabilitiesAudit]: undefined,
  [Ipc.mcpClientsStatus]: undefined,
  [Ipc.mcpClientUninstall]: { clientId: 'codex' },
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
// A capability call appends its audit line after it answers; let it land before the temp data root is removed.
afterEach(async () => {
  await stopMcpServer()
  await flushCapabilityAudit()
})

describe('设置 › 功能 › 外部 Agent', () => {
  it('is off for a new install and for a settings file written before the switch existed', () => {
    expect(DEFAULT_SETTINGS.externalAgentsEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.workerHostsEnabled).toBe(false)
  })

  it('refuses every channel of the feature while it is off, without starting anything', async () => {
    const probe = vi.spyOn(discovery, 'findCli')
    await syncExternalAgents(DEFAULT_SETTINGS)
    for (const [channel, payload] of Object.entries(EXTERNAL_CHANNELS)) {
      const result = await invoke(channel, payload)
      expect(result, channel).toMatchObject({ ok: false, error: { code: 'E_FEATURE_OFF' } })
    }
    expect(getActiveMcpServer()).toBeNull()
    expect(existsSync(paths.mcpDiscovery())).toBe(false)
    expect(existsSync(paths.mcpDir())).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    probe.mockRestore()
  })

  it('gates the five dedicated redraw channels independently; generic IPC stays read only', async () => {
    const id = 'ccbb1936-c34f-4207-8a4a-844a5a3e3df3',
      draft = { protocol: 'openai-chat', baseUrl: 'https://image.example/v1' },
      input = { channelId: id, revision: id, projectId: 'test', path: 'test.png', prompt: 'a' }
    updateSettings({ externalImageEditEnabled: false, externalAgentsEnabled: true })
    for (const [ch, p] of [
      [Ipc.imageEditChannelsList, {}],
      [Ipc.imageEditChannelsSave, { ...draft, name: 'mine', model: 'model' }],
      [Ipc.imageEditDiscoverModels, draft],
      [Ipc.imageEditChannelsRemove, { id }],
      [Ipc.imageEditRun, input],
      [Ipc.imageEditCancel, { runId: id }],
    ] as const)
      expect(await invoke(ch, p)).toMatchObject({ ok: false, error: { code: 'E_FEATURE_OFF' } })
    expect(existsSync(paths.imageEditChannels())).toBe(false)
    expect(existsSync(paths.imageEditCredentials())).toBe(false)
    updateSettings({ externalImageEditEnabled: true, externalAgentsEnabled: false })
    expect(await invoke(Ipc.imageEditChannelsList, {})).toMatchObject({ ok: true })
    updateSettings({ externalAgentsEnabled: true })
    expect(await invoke(Ipc.capabilitiesExecute, { name: 'image.edit.run', arguments: input })).toMatchObject({ data: { ok: false } })
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
