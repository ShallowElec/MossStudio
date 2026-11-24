import { expect, it, vi } from 'vitest'
import { mcpConfigJson } from '@renderer/pages/studio/assistant/collabClient'

// A timeout other than today's 180 s shows the DSH entry follows the shared one instead of a copy of its value.
vi.mock('@shared/mcpClients', async (importOriginal) => ({ ...(await importOriginal<object>()), CLIENT_TOOL_TIMEOUT_SEC: 321 }))

it('gives DSH the same tool timeout MossStudio sets for Codex', () => {
  const bridge = { command: '/usr/bin/node', args: ['/b.mjs'], env: { MOSSSTUDIO_MCP_DISCOVERY: '/d.json' } }
  const connection = { url: 'http://127.0.0.1:1/mcp', token: 'secret', toolCount: 3, bridge }
  expect(JSON.parse(mcpConfigJson(connection, 'dsh')).toolCallTimeoutMs).toBe(321_000)
})
