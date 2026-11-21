import { app } from 'electron'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AgentBackendInfo,
  AgentDriver,
  AgentHubEvent,
  AgentMessagePage,
  AgentModels,
  AgentSendInput,
  AgentSession,
  AgentSetModelInput,
} from '@shared/agentHub'
import { getMcpServerState } from '../mcp/server'
import { bridgeLaunch, findExecutableOnPath } from '../mcp/clientInstaller'

/** A turn that streams nothing for this long is stopped: the Agent hung or lost its model. */
export const PROMPT_IDLE_TIMEOUT_MS = 10 * 60_000
/** Pages of `session/list` read at most. */
const SESSION_LIST_PAGES = 10

export async function resolveAcpLaunch(
  command: string,
  args: string[],
  platform: string = process.platform,
): Promise<{ command: string; args: string[] }> {
  if (platform !== 'win32') return { command, args }
  let candidate = command
  if (!existsSync(candidate)) {
    const found = await new Promise<string>((done) =>
      execFile('where.exe', [command], { timeout: 2000, windowsHide: true }, (error, stdout) => done(error ? '' : stdout)),
    )
    const matches = found.trim().split(/\r?\n/).filter(Boolean)
    candidate = matches.find((path) => /\.exe$/i.test(path)) ?? matches.find((path) => /\.cmd$/i.test(path)) ?? command
  }
  if (!/\.(?:exe|cmd)$/i.test(candidate) && existsSync(`${candidate}.cmd`)) candidate += '.cmd'
  if (!/\.cmd$/i.test(candidate)) return { command: candidate, args }
  const contents = readFileSync(candidate, 'utf8')
  const match = /"%dp0%[\\/]([^"\r\n%]+\.(?:js|mjs|cjs))"/i.exec(contents)
  if (!match) throw new Error('此 Windows 命令不是可安全启动的 Node.js shim，请填写脚本入口。')
  const script = resolve(dirname(candidate), match[1]!.replace(/\\/g, '/'))
  if (!existsSync(script)) throw new Error('Agent 的脚本入口不存在，请重新安装命令。')
  // As npm's own shim: the node beside it, else the one on PATH; this app's binary (run as node) only without either.
  const localNode = resolve(dirname(candidate), 'node.exe')
  const pathNode = findExecutableOnPath(['node'], process.env, 'win32')
  return { command: existsSync(localNode) ? localNode : (pathNode ?? process.execPath), args: [script, ...args] }
}

/** The environment of a child: Electron runs a script as node only with ELECTRON_RUN_AS_NODE, and only this app's own binary needs it. */
export function childEnv(command: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return command === process.execPath ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env
}

function attachmentSummary(input: AgentSendInput): string {
  return [input.text, ...(input.attachments ?? []).map((file) => `${file.name} (${file.mime})`)].join('\n')
}

const probes = new Map<string, { expires: number; result: Promise<boolean> }>()
export function clearAcpProbeCache(): void {
  probes.clear()
}
export function probeAcpCommand(command: string): Promise<boolean> {
  const cached = probes.get(command)
  if (cached && cached.expires > Date.now()) return cached.result
  const result = new Promise<boolean>((resolve) => {
    execFile(process.platform === 'win32' ? 'where.exe' : 'which', [command], { timeout: 2000, windowsHide: true }, (error) =>
      resolve(!error),
    )
  }).then((found) => {
    // Never stick a stale negative cache so freshly installed ACP Agents appear immediately on refresh.
    if (!found) probes.delete(command)
    return found
  })
  probes.set(command, { expires: Date.now() + 30_000, result })
  return result
}

/** The prompt's content blocks: the text, then each picture inline (the Agent gets the bytes; nothing is written to disk). */
function buildAcpPromptBlocks(input: AgentSendInput, bodyText: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: bodyText }]
  for (const attachment of input.attachments ?? []) {
    if (attachment.dataUrl) {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(attachment.dataUrl)
      if (match) blocks.push({ type: 'image', data: match[2]!, mimeType: match[1] || attachment.mime || 'image/png' })
    }
  }
  return blocks
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
interface McpConnection {
  running: boolean
  url: string | null
  token: string | null
  stdioBridgePath: string
  discoveryPath: string
}

interface SessionState {
  info: AgentSession
  page: AgentMessagePage
  active: boolean
  assistant?: number
  /** The last message is the person's, still being replayed by `session/load`. */
  replayingUser?: boolean
  /** While `session/load` replays history: nothing is streamed to the panel. */
  loading?: boolean
}

export function createAcpDriver(options: {
  id: string
  label: string
  command?: string
  emit: (event: AgentHubEvent) => void
  getMcpState?: () => McpConnection
  timeoutMs?: number
  promptIdleMs?: number
}): AgentDriver {
  let child: ChildProcessWithoutNullStreams | undefined
  let connected = false
  let httpMcp = false
  /** The Agent can resume a conversation after a restart (`loadSession`) and list them (`sessionCapabilities.list`). */
  let canLoad = false
  let canList = false
  let sequence = 0
  let defaultModels: AgentModels = { models: [] }
  const modelStates = new Map<string, AgentModels>()
  const modelOptionIds = new Map<string, string>()
  /** Conversations the Agent listed but that are not loaded in this run yet. */
  const listed = new Map<string, AgentSession>()
  const loads = new Map<string, Promise<SessionState>>()
  const parseModels = (value: Record<string, unknown>, sessionId?: string): AgentModels => {
    const state = object(value.models)
    const available = Array.isArray(state.availableModels) ? state.availableModels : []
    const models: AgentModels = {
      models: available
        .map((item) => {
          const model = object(item)
          return { id: text(model.modelId), label: text(model.name) || text(model.modelId) }
        })
        .filter((item) => item.id),
      currentModel: text(state.currentModelId) || undefined,
    }
    const configs = Array.isArray(value.configOptions) ? value.configOptions : []
    for (const raw of configs) {
      const config = object(raw)
      if (config.category !== 'model' && config.id !== 'model') continue
      if (sessionId) modelOptionIds.set(sessionId, text(config.id))
      models.currentModel = text(config.currentValue) || models.currentModel
      if (Array.isArray(config.options))
        models.models = config.options
          .map((rawOption) => {
            const option = object(rawOption)
            return { id: text(option.value), label: text(option.name) || text(option.value) }
          })
          .filter((item) => item.id)
    }
    return models
  }
  let command = options.command
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >()
  const sessions = new Map<string, SessionState>()
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const info = (available: boolean): AgentBackendInfo => ({
    id: options.id,
    label: options.label,
    kind: 'acp',
    connected,
    available,
    command,
    resumable: connected && canLoad && canList,
  })
  const emit = (sessionId: string, event: Omit<AgentHubEvent, 'backendId' | 'sessionId'>) =>
    options.emit({ backendId: options.id, sessionId, ...event })
  const failPending = (error: Error) => {
    for (const item of pending.values()) {
      if (item.timer) clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
  }
  const write = (value: unknown) => {
    if (!child || child.killed || !child.stdin.writable) throw new Error('Agent 尚未连接，请先连接后端')
    child.stdin.write(`${JSON.stringify(value)}\n`)
  }
  /** One request; `timeoutOverrideMs` 0 means no overall limit (a turn is bounded by its idle timer instead). */
  const request = (method: string, params: unknown, timeoutOverrideMs?: number): { id: number; promise: Promise<unknown> } => {
    const id = ++sequence
    const promise = new Promise((resolve, reject) => {
      const ms = timeoutOverrideMs !== undefined ? timeoutOverrideMs : (options.timeoutMs ?? 120_000)
      const timer =
        ms > 0
          ? setTimeout(() => {
              pending.delete(id)
              reject(new Error('Agent 请求超时，请重新连接'))
              void disconnect()
            }, ms)
          : undefined
      pending.set(id, { resolve, reject, timer })
      try {
        write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        if (timer) clearTimeout(timer)
        pending.delete(id)
        reject(error as Error)
      }
    })
    return { id, promise }
  }
  const rpc = (method: string, params: unknown, timeoutOverrideMs?: number): Promise<unknown> =>
    request(method, params, timeoutOverrideMs).promise
  const setModel = async (input: AgentSetModelInput): Promise<{ ok: true; model: string; provider?: string; reasoningEffort?: string }> => {
    if (input.provider || input.reasoningEffort) throw new Error('此 ACP 后端暂不支持单独选择供应商或推理强度')
    await sessionState(input.sessionId)
    const configId = modelOptionIds.get(input.sessionId)
    await rpc(
      configId ? 'session/set_config_option' : 'session/set_model',
      configId ? { sessionId: input.sessionId, configId, value: input.model } : { sessionId: input.sessionId, modelId: input.model },
    )
    const state = modelStates.get(input.sessionId) ?? { models: [] }
    state.currentModel = input.model
    modelStates.set(input.sessionId, state)
    const session = sessions.get(input.sessionId)
    if (session) session.info.model = input.model
    return { ok: true, model: input.model }
  }
  const touch = (sessionId: string) => {
    const timer = idleTimers.get(sessionId)
    if (timer) timer.refresh()
  }
  const update = (params: Record<string, unknown>) => {
    const sessionId = text(params.sessionId)
    const session = sessions.get(sessionId)
    if (!session) return
    touch(sessionId)
    const change = object(params.update)
    const kind = text(change.sessionUpdate)
    if (kind === 'user_message_chunk') {
      // The person's own messages belong only to the history `session/load` replays; a live turn already holds them.
      if (!session.loading) return
      const content = object(change.content)
      if (content.type !== 'text') return
      session.assistant = undefined
      if (!session.replayingUser) session.page.messages.push({ seq: ++session.page.asOfSeq, role: 'user', text: '' })
      session.replayingUser = true
      session.page.messages.at(-1)!.text += text(content.text)
    } else if (kind === 'agent_message_chunk') {
      const content = object(change.content)
      if (content.type !== 'text') return
      const chunk = text(content.text)
      session.replayingUser = false
      if (session.assistant === undefined) {
        session.assistant = session.page.messages.length
        session.page.messages.push({ seq: ++session.page.asOfSeq, role: 'assistant', text: '' })
      }
      session.page.messages[session.assistant]!.text += chunk
      if (!session.loading) emit(sessionId, { type: 'delta', text: chunk })
    } else if (session.loading) {
      return
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const terminal = change.status === 'completed' || change.status === 'failed'
      emit(sessionId, {
        type: terminal ? 'tool-end' : 'tool-start',
        callId: text(change.toolCallId),
        toolName: text(change.title),
        ...(terminal ? { ok: change.status === 'completed' } : {}),
      })
    } else emit(sessionId, { type: 'status', text: kind })
  }
  async function disconnect(): Promise<void> {
    connected = false
    canLoad = false
    canList = false
    const current = child
    child = undefined
    failPending(new Error('Agent 已断开连接'))
    for (const timer of idleTimers.values()) clearTimeout(timer)
    idleTimers.clear()
    sessions.clear()
    listed.clear()
    loads.clear()
    modelStates.clear()
    modelOptionIds.clear()
    if (!current || current.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        current.kill('SIGKILL')
        resolve()
      }, 3000)
      current.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      if (process.platform === 'win32' && current.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(current.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => current.kill('SIGKILL'))
      } else {
        try {
          if (current.pid) process.kill(-current.pid, 'SIGKILL')
          else current.kill('SIGKILL')
        } catch {
          current.kill('SIGKILL')
        }
      }
    })
  }
  const mcpServers = (): unknown[] => {
    const mcp = (options.getMcpState ?? (() => getMcpServerState(true)))()
    if (!mcp.running || !mcp.url || !mcp.token) return []
    if (httpMcp)
      return [{ type: 'http', name: 'MossStudio', url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }]
    // Prefers the person's node; this app runs the bridge as node only without one.
    const launch = bridgeLaunch({ stdioBridgePath: mcp.stdioBridgePath, discoveryPath: mcp.discoveryPath })
    return [
      {
        name: 'MossStudio',
        command: launch.command,
        args: launch.args,
        env: Object.entries(launch.env).map(([name, value]) => ({ name, value })),
      },
    ]
  }
  /** A conversation by id: one of this run, or one the Agent keeps, loaded (and its history replayed) on first use. */
  const sessionState = (sessionId: string): Promise<SessionState> => {
    const known = sessions.get(sessionId)
    if (known) return Promise.resolve(known)
    if (!connected || !canLoad) return Promise.reject(new Error('Agent 会话不存在'))
    const running = loads.get(sessionId)
    if (running) return running
    const meta = listed.get(sessionId)
    const state: SessionState = {
      info: meta ? { ...meta } : { id: sessionId, title: 'Agent 会话' },
      page: { messages: [], hasMore: false, asOfSeq: 0 },
      active: false,
      loading: true,
    }
    sessions.set(sessionId, state)
    const load = rpc('session/load', { sessionId, cwd: state.info.cwd ?? process.cwd(), mcpServers: mcpServers() })
      .then((result) => {
        state.loading = false
        state.replayingUser = false
        state.assistant = undefined
        const models = parseModels(object(result), sessionId)
        modelStates.set(sessionId, models.models.length ? models : defaultModels)
        if (models.currentModel) state.info.model = models.currentModel
        return state
      })
      .catch((error: unknown) => {
        sessions.delete(sessionId)
        throw error instanceof Error ? error : new Error(String(error))
      })
      .finally(() => loads.delete(sessionId))
    loads.set(sessionId, load)
    return load
  }
  return {
    id: options.id,
    async probe() {
      return info(command ? await probeAcpCommand(command) : true)
    },
    async connect(input) {
      await disconnect()
      command = input.customCommand ?? options.command
      if (!command) throw new Error('请填写 ACP 命令')
      const launch = await resolveAcpLaunch(command, input.customArgs ?? [])
      child = spawn(launch.command, launch.args, {
        env: childEnv(launch.command),
        stdio: 'pipe',
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: false,
      })
      const current = child
      current.stdin.on('error', () => failPending(new Error('Agent 输入通道已关闭')))
      current.stderr.resume()
      current.once('error', () => {
        connected = false
        failPending(new Error('无法启动 Agent，请检查命令是否已安装'))
      })
      current.once('close', () => {
        if (child !== current) return
        connected = false
        failPending(new Error('Agent 进程已退出'))
        for (const [sessionId, session] of sessions)
          if (session.active) {
            session.active = false
            session.info.running = false
            emit(sessionId, { type: 'error', message: 'Agent 进程已退出' })
          }
      })
      const lines = createInterface({ input: current.stdout })
      lines.on('line', (line) => {
        if (line.length > 4 * 1024 * 1024) {
          void disconnect()
          return
        }
        let message: Record<string, unknown>
        try {
          message = object(JSON.parse(line) as unknown)
        } catch {
          return
        }
        if (message.method === 'session/update') update(object(message.params))
        else if (typeof message.method === 'string' && message.id !== undefined) {
          // ACP-side permission and filesystem requests are not a bypass around Studio approval.
          write({
            jsonrpc: '2.0',
            id: message.id,
            ...(message.method === 'session/request_permission'
              ? { result: { outcome: { outcome: 'cancelled' } } }
              : { error: { code: -32601, message: 'Unsupported client method' } }),
          })
        } else if (typeof message.id === 'number') {
          const pendingRequest = pending.get(message.id)
          if (!pendingRequest) return
          clearTimeout(pendingRequest.timer)
          pending.delete(message.id)
          if (message.error) pendingRequest.reject(new Error(text(object(message.error).message) || 'Agent 请求失败'))
          else pendingRequest.resolve(message.result)
        }
      })
      try {
        const result = object(
          await rpc('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'mossstudio', version: app?.getVersion?.() || '2.0.1' },
          }),
        )
        defaultModels = parseModels(result)
        const capabilities = object(result.agentCapabilities)
        httpMcp = object(capabilities.mcpCapabilities).http === true
        canLoad = capabilities.loadSession === true
        canList = Boolean(object(capabilities.sessionCapabilities).list)
        connected = true
        return info(true)
      } catch (error) {
        await disconnect()
        throw error
      }
    },
    disconnect,
    async listSessions() {
      if (connected && canList) {
        // The Agent's own list, so conversations from before a restart are there to load.
        const rows: unknown[] = []
        let cursor = ''
        // Follows the Agent's pages, up to a bound, so a conversation bound to a project is not lost past the first.
        for (let page = 0; page < SESSION_LIST_PAGES; page++) {
          const result = object(await rpc('session/list', cursor ? { cursor } : {}))
          if (Array.isArray(result.sessions)) rows.push(...result.sessions)
          cursor = text(result.nextCursor)
          if (!cursor) break
        }
        for (const raw of rows) {
          const row = object(raw)
          const id = text(row.sessionId)
          if (!id || sessions.has(id)) continue
          const updatedAt = Date.parse(text(row.updatedAt))
          listed.set(id, {
            id,
            title: text(row.title) || 'Agent 会话',
            ...(text(row.cwd) ? { cwd: text(row.cwd) } : {}),
            ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
          })
        }
      }
      const live = [...sessions.values()].map(({ info: session }) => ({ ...session }))
      const ids = new Set(live.map((session) => session.id))
      return [...live, ...[...listed.values()].filter((session) => !ids.has(session.id)).map((session) => ({ ...session }))]
    },
    async createSession(input) {
      if (!connected) throw new Error('请先连接 Agent')
      const result = object(await rpc('session/new', { cwd: input.cwd ?? process.cwd(), mcpServers: mcpServers() }))
      const sessionId = text(result.sessionId)
      if (!sessionId) throw new Error('Agent 未返回有效会话')
      sessions.set(sessionId, {
        info: { id: sessionId, title: input.title || 'Agent 会话', cwd: input.cwd, updatedAt: Date.now() },
        page: { messages: [], hasMore: false, asOfSeq: 0 },
        active: false,
      })
      const state = parseModels(result, sessionId)
      modelStates.set(sessionId, state.models.length ? state : defaultModels)
      const session = sessions.get(sessionId)!
      session.info.projectId = input.projectId
      session.info.model = state.currentModel
      if (input.model) await setModel({ backendId: options.id, sessionId, model: input.model, provider: input.provider })
      return { sessionId }
    },
    async models(sessionId) {
      if (sessionId) await sessionState(sessionId).catch(() => undefined)
      return structuredClone((sessionId ? modelStates.get(sessionId) : undefined) ?? defaultModels)
    },
    setModel,
    async readMessages(sessionId) {
      const session = await sessionState(sessionId)
      return { ...session.page, messages: session.page.messages.map((message) => ({ ...message })) }
    },
    async send(input) {
      const session = await sessionState(input.sessionId)
      if (session.active) throw new Error('Agent 正在回复，请先停止当前轮')
      session.active = true
      session.info.running = true
      session.assistant = undefined
      session.page.messages.push({ seq: ++session.page.asOfSeq, role: 'user', text: input.text })
      const content = attachmentSummary(input) + (input.studioContext ? `\n\n[Current Studio context]\n${input.studioContext}` : '')
      const promptBlocks = buildAcpPromptBlocks(input, content)
      emit(input.sessionId, { type: 'status', text: '正在思考' })
      // No overall limit (a turn may run long), but one that streams nothing for too long is stopped.
      const prompt = request('session/prompt', { sessionId: input.sessionId, prompt: promptBlocks }, 0)
      const idle = setTimeout(() => {
        const waiting = pending.get(prompt.id)
        pending.delete(prompt.id)
        try {
          write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: input.sessionId } })
        } catch {
          // The Agent is gone; the turn ends below either way.
        }
        waiting?.reject(new Error('Agent 很久没有回应，已停止这一轮'))
      }, options.promptIdleMs ?? PROMPT_IDLE_TIMEOUT_MS)
      idleTimers.set(input.sessionId, idle)
      void prompt.promise
        .then(() => {
          emit(input.sessionId, { type: 'done' })
        })
        .catch((error: unknown) => {
          emit(input.sessionId, { type: 'error', message: error instanceof Error ? error.message : String(error) })
        })
        .finally(() => {
          clearTimeout(idle)
          if (idleTimers.get(input.sessionId) === idle) idleTimers.delete(input.sessionId)
          session.active = false
          session.info.running = false
          session.info.updatedAt = Date.now()
        })
    },
    async stop(sessionId) {
      write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    },
  }
}
