import { Events, Ipc } from '@shared/channels'
import type { AiToolCallRequest, AiToolResult } from '@shared/ai'
import { toolByName } from '@shared/agent/registry'
import { BUILTIN_CAPABILITY_REGISTRY } from '@shared/capabilities'
import { call, onEvent } from './api'
import { RENDERER_CAPABILITY_HOST, type RendererCapabilityHost } from './capabilities'
import { applyPlan, executeStudioTool, getStudioApi, setStudioApi } from './agent/executor'
import type { StudioSnapshot, StudioToolApi } from './agent/types'

export type { AddedLayer, LayerBox, LayerPatch, StudioSnapshot, StudioToolApi } from './agent/types'
export { applyPlan, executeStudioTool }

export function registerStudioTools(next: StudioToolApi | null): void {
  setStudioApi(next)
}

/** The selected canvas as it is right now (not when a chat message was typed). */
export function readStudioSnapshot(): StudioSnapshot | null {
  return getStudioApi()?.snapshot() ?? null
}

/** Write a description into the selected canvas; false when the Studio is not ready. */
export function applyStudioDescription(text: string): boolean {
  const api = getStudioApi()
  if (!api || !api.snapshot()) return false
  try {
    api.setPrompt(text)
    return true
  } catch {
    // The selected canvas is a finished result and cannot be edited.
    return false
  }
}

/** Context block appended to the assistant's system prompt on every turn. */
export function formatStudioContext(snapshot: StudioSnapshot | null): string | undefined {
  if (!snapshot) return undefined
  const lines: string[] = []
  if (snapshot.project) {
    const { canvases } = snapshot.project
    lines.push(`The project "${snapshot.project.name}" has ${canvases.length} canvas${canvases.length === 1 ? '' : 'es'}:`)
    for (const canvas of canvases.slice(0, 20)) {
      const mark = canvas.id === snapshot.project.selectedId ? ' (selected)' : ''
      lines.push(`- ${canvas.id} · ${canvas.title} · ${canvas.kind} · ${canvas.width}×${canvas.height} · ${canvas.jobState}${mark}`)
    }
    if (canvases.length > 20) lines.push(`…and ${canvases.length - 20} more; call studio_read_context to list them.`)
    lines.push(`The user is working on "${snapshot.title}" (${snapshot.width}×${snapshot.height}).`)
  } else {
    lines.push(`The user is working on the Studio canvas "${snapshot.title}" (${snapshot.width}×${snapshot.height}).`)
  }
  lines.push(snapshot.description.trim() ? `Its description currently reads:\n${snapshot.description.trim()}` : 'Its description is empty.')
  if (snapshot.regions.length) {
    lines.push('Its regions, in order:')
    snapshot.regions.forEach((region, index) => {
      const text = region.kind === 'text' && region.text ? ` [text: ${region.text}]` : ''
      const hidden = region.visible ? '' : ' (hidden)'
      lines.push(`${index + 1}. ${region.kind}: ${region.caption.trim() || '(no caption)'}${text}${hidden}`)
    })
  } else {
    lines.push('It has no regions.')
  }
  return lines.join('\n')
}

/**
 * The built-in tool a call means: a legacy `studio_*` name as it is, or a
 * capability id that supersedes one (`studio.sampling.set` → `studio_set_sampler`).
 */
export function legacyToolName(name: string): string | null {
  if (toolByName(name)) return name
  const alias = BUILTIN_CAPABILITY_REGISTRY.getAction(name)?.descriptor.legacyAlias
  return alias && toolByName(alias) ? alias : null
}

/**
 * One call an external Agent made over MCP. A capability that supersedes a
 * built-in tool runs that tool's handler; every other one goes to the renderer
 * host. Its board changes are one undo step, and the Studio follows them.
 */
export async function runExternalToolCall(
  request: AiToolCallRequest,
  host: RendererCapabilityHost = RENDERER_CAPABILITY_HOST,
): Promise<AiToolResult> {
  const legacy = legacyToolName(request.name)
  const run = (): Promise<AiToolResult> =>
    legacy
      ? executeStudioTool({ id: request.callId, name: legacy, arguments: request.arguments }, { mode: request.mode })
      : host.execute(
          { id: request.callId, name: request.name, arguments: request.arguments },
          { mode: request.mode, conversationId: request.conversationId },
        )
  const follow = getStudioApi()?.followExternal
  return follow ? follow(request.callId, run) : run()
}

/** Subscribe once; resolves every tool call the main process asks for. */
export function installStudioToolBridge(): () => void {
  return onEvent<AiToolCallRequest>(Events.aiToolCall, (request) => {
    void (async () => {
      // The 助手's own tools run as they always have; only an external Agent's call takes the capability path.
      const result = request.external
        ? await runExternalToolCall(request)
        : await executeStudioTool(
            { id: request.callId, name: request.name, arguments: request.arguments },
            { mode: request.mode, turnId: request.turnId },
          )
      await call(Ipc.aiToolResult, { callId: request.callId, result }).catch(() => undefined)
    })()
  })
}
