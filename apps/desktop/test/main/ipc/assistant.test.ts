import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from '@test/mocks/electron'
import { Events, Ipc } from '@shared/channels'
import { resolveToolset, toolDefinitions } from '@shared/agent/registry'
import type { AiToolCall, AiToolDefinition } from '@shared/ai'

const chat = vi.hoisted(() => vi.fn())
vi.mock('@main/services/ai', async (original) => ({ ...(await original<typeof import('@main/services/ai')>()), chat }))

const { registerIpc } = await import('@main/ipc')
registerIpc()

afterEach(() => chat.mockReset())

function sender() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  return { sent, isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
}

const chatInput = { providerId: 'p', message: 'hi', mode: 'auto' }

describe('main/ipc aiChat: the built-in 助手', () => {
  it('gets the 13 studio tools of its own registry, not the capability registry', async () => {
    chat.mockResolvedValue({})
    await ipcMain.handlers.get(Ipc.aiChat)!({ sender: sender() }, chatInput)
    const tools = (chat.mock.calls[0]![1] as { tools: AiToolDefinition[] }).tools
    expect(tools.map((tool) => tool.name)).toEqual(toolDefinitions(resolveToolset({ page: 'studio' })).map((tool) => tool.name))
    expect(tools).toHaveLength(13)
    expect(tools.every((tool) => tool.name.startsWith('studio_'))).toBe(true)
  })

  it("runs its tool calls in the window that asked, as the 助手's turn and never as an external Agent's", async () => {
    chat.mockResolvedValue({})
    const window = sender()
    await ipcMain.handlers.get(Ipc.aiChat)!({ sender: window }, chatInput)
    const { runTool } = chat.mock.calls[0]![1] as { runTool: (call: AiToolCall, mode: 'auto', turnId: string) => Promise<unknown> }
    const done = runTool({ id: 'call-1', name: 'studio_set_prompt', arguments: '{"prompt":"猫"}' }, 'auto', 'msg-1')
    expect(window.sent).toEqual([
      {
        channel: Events.aiToolCall,
        payload: { callId: 'call-1', name: 'studio_set_prompt', arguments: '{"prompt":"猫"}', mode: 'auto', turnId: 'msg-1' },
      },
    ])
    await ipcMain.handlers.get(Ipc.aiToolResult)!({}, { callId: 'call-1', result: { ok: true, content: '{}' } })
    await expect(done).resolves.toEqual({ ok: true, content: '{}' })
  })
})
