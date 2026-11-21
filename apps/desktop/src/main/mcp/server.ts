import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AgentMode, AiToolCall, AiToolResult } from '@shared/ai'
import {
  composeOfficialGuide,
  isMutatingEffects,
  sha256Text,
  MOSS_PROMPTCRAFT_SKILL_MD,
  MOSS_LAYOUT_DESIGN_SKILL_MD,
  type ActionDescriptor,
  type CapabilityId,
  type GuideTopic,
  type ToolProfileId,
} from '@shared/capabilities'
import { createBuiltinMainDispatcher, listCapabilityAudit, type MainCapabilityDispatcher } from '../capabilities'
import { app } from 'electron'
import { paths } from '../lib/paths'
import { attachCapabilityApproval } from '../agentHub'

/**
 * Standard MCP (Model Context Protocol) Streamable HTTP server for MossStudio.
 *
 * Thin transport adapter over `MainCapabilityDispatcher`:
 * - Listens ONLY on loopback `127.0.0.1` with an ephemeral port and its own
 *   random 256-bit Bearer token (never reuses other bridge tokens).
 * - Exposes every active capability via `tools/list` & `tools/call` (with
 *   provider-safe `a__b__c` wire names while accepting canonical/legacy aliases).
 * - Exposes live synthesized `SKILL.md`, workbench context and audit log via
 *   MCP `resources/list` + `resources/read` and `prompts/list` + `prompts/get`
 *   (in addition to the `system.guide.read` fallback tool).
 * - Converts `library.assets.read_image` payloads into native MCP image blocks.
 * - Writes `<dataRoot>/mcp-server.json` atomically so local MCP clients and the
 *   zero-dep `tools/mcp/mossstudio-mcp-stdio.mjs` proxy auto-discover it.
 */

export const MCP_PROTOCOL_VERSION = '2025-03-26'
/** Versions this server speaks; `initialize` answers with the client's when listed, else with ours. */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = ['2024-11-05', MCP_PROTOCOL_VERSION, '2025-06-18']
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Packs no MCP client is offered, whatever its profile. */
export const MCP_EXCLUDED_PACKS: readonly CapabilityId[] = ['studio.ask']

export const MCP_RESOURCE_URIS = {
  activeSkill: 'mossstudio://skill/active',
  promptcraft: 'mossstudio://skill/promptcraft',
  layout: 'mossstudio://skill/layout',
  full: 'mossstudio://skill/full',
  workbenchContext: 'mossstudio://context/workbench',
  recentAudit: 'mossstudio://audit/recent',
} as const

export interface McpServerState {
  running: boolean
  url: string | null
  token: string | null
  profile: ToolProfileId
  enabledPacks?: readonly CapabilityId[]
  toolCount: number
  packCount: number
  discoveryPath: string
  stdioBridgePath: string
  protocolVersion: string
}

export interface McpServerOptions {
  dispatcher?: MainCapabilityDispatcher
  runInRenderer?: (call: AiToolCall, mode: AgentMode, conversationId?: string) => Promise<AiToolResult>
  initialProfile?: ToolProfileId
  initialPacks?: readonly CapabilityId[]
  discoveryPath?: string
  port?: number
}

interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: string | number | null
  method?: unknown
  params?: unknown
}

export interface McpServerInstance {
  readonly url: string
  readonly token: string
  readonly port: number
  readonly discoveryPath: string
  getState(includeToken?: boolean): McpServerState
  setProfile(profile: ToolProfileId, enabledPacks?: readonly CapabilityId[]): McpServerState
  stop(): Promise<void>
}

/** Provider-safe MCP tool wire name (`a.b.c` → `a__b__c`, matches `^[a-zA-Z0-9_-]+$`). */
export function toMcpToolName(id: CapabilityId): string {
  return id.replace(/\./g, '__')
}

/** Resolve wire name (`a__b__c`), canonical id (`a.b.c`), or legacy alias (`studio_*`). */
export function fromMcpToolName(name: string): string {
  return name.includes('__') ? name.replace(/__/g, '.') : name
}

function mcpAnnotationsFor(action: ActionDescriptor): Record<string, boolean> {
  const mutating = isMutatingEffects(action.effects)
  const destructive = action.effects.includes('delete')
  return {
    readOnlyHint: !mutating,
    destructiveHint: destructive,
    idempotentHint: !mutating,
    openWorldHint: action.scope === 'application' && action.effects.includes('install'),
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function rpcOk(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: data !== undefined ? { code, message, data } : { code, message },
  }
}

function constantTimeBearerMatch(header: string | undefined, expectedToken: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false
  const received = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

/** Whether a Host header names this server on loopback (`127.0.0.1:<port>` or `localhost:<port>`). */
export function isLoopbackHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body exceeds 4 MiB limit')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text)
}

function bundledStdioBridgeSource(): string | null {
  const candidates = [
    ...(process.resourcesPath ? [join(process.resourcesPath, 'tools', 'mcp', 'mossstudio-mcp-stdio.mjs')] : []),
    resolve(process.cwd(), 'tools', 'mcp', 'mossstudio-mcp-stdio.mjs'),
    resolve(process.cwd(), '..', '..', 'tools', 'mcp', 'mossstudio-mcp-stdio.mjs'),
    join(__dirname, '..', '..', '..', '..', 'tools', 'mcp', 'mossstudio-mcp-stdio.mjs'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** Sync the bundled stdio bridge into version-independent `<dataRoot>/mcp/` so app self-updates never break external Agent configs. */
function syncStableStdioBridge(): string | null {
  const source = bundledStdioBridgeSource()
  if (!source) return null
  try {
    const stableDir = paths.mcpDir()
    const stablePath = join(stableDir, 'mossstudio-mcp-stdio.mjs')
    mkdirSync(stableDir, { recursive: true })
    const tmp = `${stablePath}.${process.pid}.tmp`
    copyFileSync(source, tmp)
    renameSync(tmp, stablePath)
    return stablePath
  } catch {
    return source
  }
}

function resolveStdioBridgePath(): string {
  const stablePath = join(paths.mcpDir(), 'mossstudio-mcp-stdio.mjs')
  if (existsSync(stablePath)) return stablePath
  return bundledStdioBridgeSource() ?? stablePath
}

function formatToolCallResult(actionId: string, result: AiToolResult): Record<string, unknown> {
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: result.content }],
      isError: true,
    }
  }
  if (actionId === 'library.assets.read_image') {
    try {
      const parsed = JSON.parse(result.content) as {
        base64?: string
        mime?: string
        path?: string
        bytes?: number
      }
      if (typeof parsed.base64 === 'string' && parsed.base64.length > 0 && typeof parsed.mime === 'string') {
        const meta = { path: parsed.path, mime: parsed.mime, bytes: parsed.bytes }
        return {
          content: [
            { type: 'image', data: parsed.base64, mimeType: parsed.mime },
            { type: 'text', text: JSON.stringify(meta) },
          ],
          isError: false,
        }
      }
    } catch {
      // Fall back to plain text response below.
    }
  }
  return {
    content: [{ type: 'text', text: result.content }],
    isError: false,
  }
}

export async function createMcpServer(options: McpServerOptions = {}): Promise<McpServerInstance> {
  const dispatcher = options.dispatcher ?? createBuiltinMainDispatcher()
  if (!options.dispatcher) attachCapabilityApproval(dispatcher)
  const token = randomBytes(32).toString('hex')
  const discoveryPath = options.discoveryPath ?? paths.mcpDiscovery()
  const stdioBridgePath = syncStableStdioBridge() ?? resolveStdioBridgePath()
  let profile: ToolProfileId = options.initialProfile ?? 'compact'
  let enabledPacks: readonly CapabilityId[] | undefined = options.initialPacks
  let stopped = false

  const activeProjected = () =>
    dispatcher.list({
      profile,
      enabledPacks,
      // 问你一句 / 等你确认 cards show only in the 助手's chat: an Agent asking there would wait for an answer nobody sees.
      excludePacks: MCP_EXCLUDED_PACKS,
      nameStyle: 'canonical',
    })

  const mcpSkillMarkdown = (): string => {
    const projected = activeProjected()
    const mcpNote = [
      '> **MCP Tool Naming**: In `tools/list`, dots `.` in canonical ids are encoded as `__` (e.g. `studio.board.diagnose` → `studio__board__diagnose`). Legacy aliases like `studio_read_context` map to `studio__board__read_context`, `studio_add_layer` → `studio__regions__add`, `studio_add_text_layer` → `studio__regions__add_text`, `studio_set_prompt` → `studio__board__set_prompt`, `studio_set_sampler` → `studio__sampling__set`, `studio_generate` → `studio__runs__generate`.',
      '> **Creative guides**: Read mossstudio://skill/promptcraft for official prompt enhancement, mossstudio://skill/layout for layout design, or mossstudio://skill/full for both plus this tools workflow.',
      `> **Active Profile**: \`${profile}\` (${projected.actions.length} tools exposed).`,
      '',
    ].join('\n')
    return projected.skill.markdown.replace('# MossStudio Active Workbench Skill\n\n', `# MossStudio Active Workbench Skill\n\n${mcpNote}`)
  }

  const writeDiscovery = (url: string): void => {
    try {
      mkdirSync(dirname(discoveryPath), { recursive: true })
      const projected = activeProjected()
      const payload = JSON.stringify(
        {
          protocol: 'mcp',
          protocolVersion: MCP_PROTOCOL_VERSION,
          transport: 'streamable-http',
          url,
          token,
          pid: process.pid,
          profile,
          ...(enabledPacks ? { enabledPacks } : {}),
          toolCount: projected.actions.length,
          skillDigest: projected.skill.digest,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )
      const tmpPath = `${discoveryPath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmpPath, discoveryPath)
    } catch {
      // Discovery file is a convenience; do not crash MCP server if filesystem is read-only.
    }
  }

  async function handleRpc(raw: JsonRpcRequest, signal?: AbortSignal): Promise<{ status: number; body?: unknown }> {
    const id = raw.id === undefined ? null : (raw.id as string | number | null)
    const method = typeof raw.method === 'string' ? raw.method : ''
    const params = raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params) ? (raw.params as Record<string, unknown>) : {}

    if (raw.jsonrpc !== '2.0' || !method) {
      return { status: 400, body: rpcError(id, -32600, 'Invalid JSON-RPC 2.0 request') }
    }

    // Notifications carry no id and expect 202 Accepted with no body.
    if (method.startsWith('notifications/')) {
      return { status: 202 }
    }

    if (method === 'ping') {
      return { status: 200, body: rpcOk(id, {}) }
    }

    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      const projected = activeProjected()
      return {
        status: 200,
        body: rpcOk(id, {
          protocolVersion: MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true },
            prompts: { listChanged: false },
          },
          serverInfo: {
            name: 'mossstudio',
            version: app?.getVersion?.() || '2.0.1',
          },
          instructions: [
            `MossStudio MCP server active (profile=${profile}, tools=${projected.actions.length}).`,
            `Read resource "${MCP_RESOURCE_URIS.activeSkill}" or call tool "${toMcpToolName('system.guide.read')}" for the live tool workflow guide. Read mossstudio://skill/promptcraft and mossstudio://skill/layout for official MOSS creative guidance, or mossstudio://skill/full for the complete guide.`,
            `Call "${toMcpToolName('studio.board.read_context')}" or "${toMcpToolName('system.context.get')}" before editing the board.`,
            `For MOSS drawing and editing tasks, use MossStudio workbench tools (${toMcpToolName('studio.cards.create')}, ${toMcpToolName('studio.board.set_prompt')}, ${toMcpToolName('studio.sampling.set_loras')}, ${toMcpToolName('studio.runs.generate')}) so cards, progress, and outputs appear live on the open canvas; avoid bypassing the canvas with standalone shell scripts, and import any externally post-processed image back with ${toMcpToolName('studio.projects.import_image')}.`,
          ].join(' '),
        }),
      }
    }

    if (method === 'tools/list') {
      const projected = activeProjected()
      return {
        status: 200,
        body: rpcOk(id, {
          tools: projected.actions.map((action) => ({
            name: toMcpToolName(action.id),
            title: action.title,
            description: `[${action.id}] ${action.description}`,
            inputSchema: action.input,
            annotations: mcpAnnotationsFor(action),
          })),
        }),
      }
    }

    if (method === 'tools/call') {
      const wireName = typeof params.name === 'string' ? params.name.trim() : ''
      if (!wireName) {
        return { status: 200, body: rpcError(id, -32602, 'tools/call requires a non-empty tool name') }
      }
      const canonicalOrAlias = fromMcpToolName(wireName)
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}
      const meta =
        params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta) ? (params._meta as Record<string, unknown>) : {}
      const mode: AgentMode = profile === 'proposal-only' || meta.mode === 'advanced' ? 'advanced' : 'auto'
      // Only what tools/list offered can be called: the profile is a boundary, not a menu.
      const allowed = new Set(activeProjected().actions.map((action) => action.id))
      const conversationId = typeof meta.conversationId === 'string' ? meta.conversationId : undefined

      if (canonicalOrAlias === 'system.guide.read' && args.profile === undefined) {
        const projected = activeProjected()
        const topic: GuideTopic = args.topic === 'tools' || args.topic === 'promptcraft' || args.topic === 'layout' ? args.topic : 'all'
        const markdown = composeOfficialGuide(mcpSkillMarkdown(), topic)
        // Record audit through dispatcher, then return the MCP-annotated markdown matching mossstudio://skill/*.
        const audited = await dispatcher.execute({
          callId: `mcp-${randomUUID()}`,
          name: canonicalOrAlias,
          arguments: { ...args, topic, profile, ...(enabledPacks ? { enabledPacks: [...enabledPacks] } : {}) },
          mode,
          source: 'external-agent',
          conversationId,
          allowed,
          signal,
          runInRenderer: options.runInRenderer,
        })
        if (!audited.ok) return { status: 200, body: rpcOk(id, formatToolCallResult(canonicalOrAlias, audited)) }
        return {
          status: 200,
          body: rpcOk(id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  topic,
                  profile: projected.profile,
                  actionCount: projected.actions.length,
                  ...projected.skill,
                  markdown,
                  digest: sha256Text(markdown),
                }),
              },
            ],
            isError: false,
          }),
        }
      }

      const result = await dispatcher.execute({
        callId: `mcp-${randomUUID()}`,
        name: canonicalOrAlias,
        arguments: args,
        mode,
        source: 'external-agent',
        conversationId,
        allowed,
        signal,
        runInRenderer: options.runInRenderer,
      })

      return {
        status: 200,
        body: rpcOk(id, formatToolCallResult(canonicalOrAlias, result)),
      }
    }

    if (method === 'resources/list') {
      return {
        status: 200,
        body: rpcOk(id, {
          resources: [
            { uri: MCP_RESOURCE_URIS.promptcraft, name: 'MOSS Official Promptcraft Skill', mimeType: 'text/markdown' },
            { uri: MCP_RESOURCE_URIS.layout, name: 'MOSS Official Layout Design Skill', mimeType: 'text/markdown' },
            { uri: MCP_RESOURCE_URIS.full, name: 'MossStudio Full Drawing Skill', mimeType: 'text/markdown' },
            {
              uri: MCP_RESOURCE_URIS.activeSkill,
              name: 'MossStudio Active Skill (SKILL.md)',
              description: `Dynamically synthesized Markdown Skill matching the active Tool Profile (${profile}).`,
              mimeType: 'text/markdown',
            },
            {
              uri: MCP_RESOURCE_URIS.workbenchContext,
              name: 'MossStudio Workbench Context',
              description: 'Live snapshot of projects, models, engine, jobs, and active capability summary.',
              mimeType: 'application/json',
            },
            {
              uri: MCP_RESOURCE_URIS.recentAudit,
              name: 'MossStudio Recent Audit Log',
              description: 'Recent capability execution audit records (操作留痕).',
              mimeType: 'application/json',
            },
          ],
        }),
      }
    }

    if (method === 'resources/read') {
      const uri = typeof params.uri === 'string' ? params.uri.trim() : ''
      const creative =
        uri === MCP_RESOURCE_URIS.promptcraft
          ? MOSS_PROMPTCRAFT_SKILL_MD
          : uri === MCP_RESOURCE_URIS.layout
            ? MOSS_LAYOUT_DESIGN_SKILL_MD
            : uri === MCP_RESOURCE_URIS.full
              ? composeOfficialGuide(mcpSkillMarkdown())
              : undefined
      if (creative !== undefined)
        return { status: 200, body: rpcOk(id, { contents: [{ uri, mimeType: 'text/markdown', text: creative }] }) }
      if (uri === MCP_RESOURCE_URIS.activeSkill) {
        return {
          status: 200,
          body: rpcOk(id, {
            contents: [
              {
                uri,
                mimeType: 'text/markdown',
                text: mcpSkillMarkdown(),
              },
            ],
          }),
        }
      }
      if (uri === MCP_RESOURCE_URIS.workbenchContext) {
        const contextResult = await dispatcher.execute({
          name: 'system.context.get',
          arguments: {},
          source: 'external-agent',
          allowed: new Set(activeProjected().actions.map((action) => action.id)),
          readOnly: true,
          runInRenderer: options.runInRenderer,
        })
        return {
          status: 200,
          body: rpcOk(id, {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: contextResult.content,
              },
            ],
          }),
        }
      }
      if (uri === MCP_RESOURCE_URIS.recentAudit) {
        // The trail is shown only to a profile that offers the tool that reads it.
        if (!activeProjected().actions.some((action) => action.id === 'system.audit.recent'))
          return { status: 200, body: rpcError(id, -32002, `Unknown MCP resource URI: ${uri}`) }
        const entries = await listCapabilityAudit({ limit: 50, source: 'external-agent' })
        return {
          status: 200,
          body: rpcOk(id, {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ entries }, null, 2),
              },
            ],
          }),
        }
      }
      return { status: 200, body: rpcError(id, -32002, `Unknown MCP resource URI: ${uri}`) }
    }

    if (method === 'prompts/list') {
      return {
        status: 200,
        body: rpcOk(id, {
          prompts: [
            {
              name: 'mossstudio-prompt-enhancer',
              title: 'MOSS Official Prompt Enhancer',
              description: 'Official promptcraft and layout design guidance adapted for MossStudio.',
              arguments: [],
            },
            {
              name: 'mossstudio-drawing-skill',
              title: 'MossStudio Drawing Skill',
              description: 'Inject the active dynamically synthesized MossStudio SKILL.md into the conversation.',
              arguments: [],
            },
          ],
        }),
      }
    }

    if (method === 'prompts/get') {
      const promptName = typeof params.name === 'string' ? params.name.trim() : ''
      if (!['mossstudio-drawing-skill', 'mossstudio-prompt-enhancer'].includes(promptName)) {
        return { status: 200, body: rpcError(id, -32602, `Unknown prompt: ${promptName}`) }
      }
      const projected = activeProjected()
      const promptText =
        promptName === 'mossstudio-prompt-enhancer'
          ? [MOSS_PROMPTCRAFT_SKILL_MD, MOSS_LAYOUT_DESIGN_SKILL_MD].join('\n\n')
          : composeOfficialGuide(mcpSkillMarkdown(), 'all')
      return {
        status: 200,
        body: rpcOk(id, {
          description:
            promptName === 'mossstudio-prompt-enhancer'
              ? 'MOSS official promptcraft and layout design skill'
              : `MossStudio dynamic skill (${profile}, ${projected.actions.length} tools)`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: promptText,
              },
            },
          ],
        }),
      }
    }

    return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) }
  }

  let listeningPort = 0
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname

      // A web page can reach a loopback port: browsers send Origin, MCP clients do not, and a rebound name fails the Host check.
      if (req.headers.origin !== undefined || !isLoopbackHost(req.headers.host, listeningPort)) {
        sendJson(res, 403, { error: 'Forbidden' })
        return
      }

      if (path !== '/mcp' && path !== '/health') {
        sendJson(res, 404, { error: 'Not found' })
        return
      }

      if (!constantTimeBearerMatch(req.headers.authorization, token)) {
        sendJson(res, 401, { error: 'Unauthorized: valid Bearer token required' })
        return
      }

      if (req.method === 'GET' && path === '/health') {
        const projected = activeProjected()
        sendJson(res, 200, {
          ok: true,
          protocol: 'mcp',
          protocolVersion: MCP_PROTOCOL_VERSION,
          profile,
          toolCount: projected.actions.length,
          skillDigest: projected.skill.digest,
        })
        return
      }

      if (req.method === 'DELETE') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed; send JSON-RPC 2.0 via POST /mcp' })
        return
      }

      // The Agent gave up (its tool timeout) or went away: a call still waiting for approval is dropped.
      const gone = new AbortController()
      res.once('close', () => {
        if (!res.writableFinished) gone.abort()
      })

      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, rpcError(null, -32700, error instanceof Error ? error.message : 'Invalid JSON'))
        return
      }

      if (Array.isArray(body)) {
        const responses: unknown[] = []
        for (const item of body) {
          const outcome = await handleRpc(item as JsonRpcRequest, gone.signal)
          if (outcome.body !== undefined) responses.push(outcome.body)
        }
        if (responses.length === 0) {
          res.writeHead(202)
          res.end()
          return
        }
        sendJson(res, 200, responses)
        return
      }

      const outcome = await handleRpc(body as JsonRpcRequest, gone.signal)
      if (outcome.body === undefined) {
        res.writeHead(outcome.status)
        res.end()
        return
      }
      sendJson(res, outcome.status, outcome.body)
    })().catch((error) => {
      sendJson(res, 500, rpcError(null, -32603, error instanceof Error ? error.message : String(error)))
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address() as AddressInfo
  listeningPort = address.port
  const url = `http://127.0.0.1:${address.port}/mcp`
  writeDiscovery(url)

  const getState = (includeToken = false): McpServerState => {
    const projected = activeProjected()
    const packIds = new Set(projected.actions.map((action) => action.packId))
    return {
      running: !stopped,
      url: stopped ? null : url,
      token: includeToken && !stopped ? token : null,
      profile,
      ...(enabledPacks ? { enabledPacks } : {}),
      toolCount: projected.actions.length,
      packCount: packIds.size,
      discoveryPath,
      stdioBridgePath,
      protocolVersion: MCP_PROTOCOL_VERSION,
    }
  }

  return {
    url,
    token,
    port: address.port,
    discoveryPath,
    getState,
    setProfile(nextProfile: ToolProfileId, nextPacks?: readonly CapabilityId[]): McpServerState {
      profile = nextProfile
      enabledPacks = nextPacks
      if (!stopped) writeDiscovery(url)
      return getState(false)
    },
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      try {
        rmSync(discoveryPath, { force: true })
      } catch {
        // Ignore cleanup errors on exit.
      }
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

let activeServer: McpServerInstance | null = null
/** A start in progress: a second caller waits for it instead of starting another server. */
let starting: Promise<McpServerInstance> | null = null

export async function startMcpServer(options: McpServerOptions = {}): Promise<McpServerInstance> {
  if (activeServer) return activeServer
  starting ??= createMcpServer(options)
    .then((server) => (activeServer = server))
    .finally(() => (starting = null))
  return starting
}

export async function stopMcpServer(): Promise<void> {
  if (starting) await starting.catch(() => undefined)
  if (!activeServer) return
  const current = activeServer
  activeServer = null
  await current.stop()
}

export function getActiveMcpServer(): McpServerInstance | null {
  return activeServer
}

export function getMcpServerState(includeToken = false): McpServerState {
  if (activeServer) return activeServer.getState(includeToken)
  return {
    running: false,
    url: null,
    token: null,
    profile: 'compact',
    toolCount: 0,
    packCount: 0,
    discoveryPath: paths.mcpDiscovery(),
    stdioBridgePath: resolveStdioBridgePath(),
    protocolVersion: MCP_PROTOCOL_VERSION,
  }
}
