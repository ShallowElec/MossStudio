import type {
  AgentConnectInput,
  AgentCreateSessionInput,
  AgentDriver,
  AgentSendInput,
  AgentSetModelInput,
  AgentSessionStats,
} from '@shared/agentHub'
import { mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const MAX_CWD = 4096

/**
 * Make the new project folder the person asked for. The path comes from the
 * renderer, so it must be a plain absolute path that cannot climb out with `..`.
 */
export async function ensureProjectFolder(cwd: string): Promise<string> {
  const folder = cwd.trim()
  if (!folder || folder.length > MAX_CWD || folder.includes('\0')) throw new Error('新项目文件夹的路径无效，请重新选择')
  if (!isAbsolute(folder)) throw new Error('新项目文件夹必须是完整路径（例如 D:\\work\\poster），请重新选择所在目录')
  if (folder.split(/[\\/]+/).includes('..')) throw new Error('新项目文件夹的路径不能包含 ..，请重新选择')
  await mkdir(folder, { recursive: true })
  return folder
}

export function createAgentHub(
  drivers: readonly AgentDriver[],
  metrics: () => Promise<{ activeMcpTools: number; recentToolCalls: number }> = async () => ({ activeMcpTools: 0, recentToolCalls: 0 }),
) {
  const registry = new Map(drivers.map((driver) => [driver.id, driver]))
  const get = (id: string): AgentDriver => {
    const driver = registry.get(id)
    if (!driver) throw new Error('未知 Agent 后端，请重新选择')
    return driver
  }
  return {
    backends: () => Promise.all(drivers.map((driver) => driver.probe())),
    models: (backendId: string, sessionId?: string) => get(backendId).models(sessionId),
    setModel: (input: AgentSetModelInput) => get(input.backendId).setModel(input),
    async sessionStats(backendId: string, sessionId: string): Promise<AgentSessionStats> {
      const driver = get(backendId)
      const [page, sessions, telemetry, counts] = await Promise.all([
        driver.readMessages(sessionId),
        driver.listSessions(),
        driver.telemetry?.(sessionId),
        metrics(),
      ])
      const session = sessions.find((item) => item.id === sessionId)
      return {
        messageCount: page.messages.length,
        userTurns: page.messages.filter((item) => item.role === 'user').length,
        assistantTurns: page.messages.filter((item) => item.role === 'assistant').length,
        estimatedChars: page.messages.reduce((sum, item) => sum + item.text.length, 0),
        ...counts,
        model: session?.model,
        provider: session?.provider,
        cwd: session?.cwd,
        running: session?.running ?? false,
        updatedAt: session?.updatedAt,
        ...telemetry,
      }
    },
    connect: (input: AgentConnectInput) => get(input.backendId).connect(input),
    async disconnect(backendId: string) {
      await get(backendId).disconnect()
      return true
    },
    sessions: (backendId: string) => get(backendId).listSessions(),
    async createSession({ createCwd, ...input }: AgentCreateSessionInput) {
      const driver = get(input.backendId)
      if (createCwd === true && input.cwd?.trim()) input.cwd = await ensureProjectFolder(input.cwd)
      return driver.createSession(input)
    },
    messages: (backendId: string, sessionId: string) => get(backendId).readMessages(sessionId),
    async send(input: AgentSendInput) {
      await get(input.backendId).send(input)
      return true
    },
    async stop(backendId: string, sessionId: string) {
      await get(backendId).stop(sessionId)
      return true
    },
    async shutdown() {
      await Promise.all(drivers.map((driver) => driver.disconnect()))
    },
  }
}
