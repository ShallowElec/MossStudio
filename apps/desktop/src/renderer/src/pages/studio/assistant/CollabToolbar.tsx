import { useState } from 'react'
import { Boxes, ChevronDown, Copy, Plug } from 'lucide-react'
import {
  ALL_CAPABILITY_PACKS,
  BUILTIN_CAPABILITY_REGISTRY,
  MOSS_LAYOUT_PROFILE_PACKS,
  MOSS_STANDARD_PROFILE_PACKS,
  projectCapabilities,
  type CapabilityId,
  type ToolProfileId,
} from '@shared/capabilities'
import { useApp } from '../../../store'
import { Checkbox } from '../../../components/common/Checkbox'
import { Popover } from '../../../components/common/Popover'
import { Button, Select, cn, useCopyText, useToast } from '../../../components/ui'
import { mcpConfigJson, type CollabClient } from './collabClient'

const TOOL_PROFILE_KEY = 'mossstudio.collab.toolProfile'
const TOOL_PACKS_KEY = 'mossstudio.collab.toolPacks'

export const PROFILE_LABELS: Record<ToolProfileId, string> = {
  compact: '精简工具组',
  'moss-standard': '普通绘画预设',
  'moss-layout': '分区构图预设',
  atomic: '原子全工具',
  'proposal-only': '仅提案确认',
  custom: '自定义包',
}

export const PROFILE_ORDER: readonly ToolProfileId[] = ['compact', 'moss-standard', 'moss-layout', 'atomic', 'proposal-only', 'custom']

/** The packs the 精简 profile exposes: the board, models, pictures and the runtime, without GBC, comics or training. */
export const COMPACT_PACKS: readonly CapabilityId[] = [
  'studio.board.read',
  'studio.ask',
  'studio.board.cards',
  'studio.board.regions',
  'studio.board.sampling',
  'studio.board.wires',
  'studio.board.runs',
  'studio.projects',
  'models.catalog',
  'library.assets',
  'system.runtime',
]

export const MOSS_STANDARD_PACKS: readonly CapabilityId[] = MOSS_STANDARD_PROFILE_PACKS.filter((id) => id !== 'remote.hosts')
export const MOSS_LAYOUT_PACKS: readonly CapabilityId[] = MOSS_LAYOUT_PROFILE_PACKS.filter((id) => id !== 'remote.hosts')

export interface ToolProfileState {
  mode: ToolProfileId
  /** The packs of `custom`; kept while another mode is picked so switching back restores them. */
  packs: readonly CapabilityId[]
}

export interface PackRow {
  id: CapabilityId
  title: string
  actionCount: number
  isSkill: boolean
}

/** Every built-in pack in registry order, feature-flagged ones included: the list is what may be offered. */
const ALL_FLAGS: Readonly<Record<string, boolean>> = Object.fromEntries(
  ALL_CAPABILITY_PACKS.flatMap((pack) => (pack.featureFlag ? [[pack.featureFlag, true] as const] : [])),
)
const PACK_ROWS: readonly PackRow[] = BUILTIN_CAPABILITY_REGISTRY.listPacks({ enabledFlags: ALL_FLAGS }).map((pack) => ({
  id: pack.id,
  title: pack.title,
  actionCount: pack.actions.length,
  isSkill: pack.id.startsWith('skill.'),
}))

export function listPackRows(imageEdit = false): readonly PackRow[] {
  return PACK_ROWS.filter((row) => imageEdit || row.id !== 'image.edit')
}

const allPackIds = (imageEdit = false): CapabilityId[] => listPackRows(imageEdit).map((row) => row.id)
// The guide packs are opt-in: the atomic and proposal-only projections leave them out, so the ticks do too.
const toolPackIds = (imageEdit = false): CapabilityId[] =>
  listPackRows(imageEdit)
    .filter((row) => !row.isSkill)
    .map((row) => row.id)

/** The packs a mode actually exposes, for the ticks in the pack list. */
export function effectivePacks(state: ToolProfileState, imageEdit = false): readonly CapabilityId[] {
  if (state.mode === 'custom') return state.packs.filter((id) => imageEdit || id !== 'image.edit')
  if (state.mode === 'compact') return COMPACT_PACKS
  if (state.mode === 'moss-standard') return MOSS_STANDARD_PACKS
  if (state.mode === 'moss-layout') return MOSS_LAYOUT_PACKS
  return toolPackIds(imageEdit)
}

/** Ticking a pack always lands in `custom`, starting from what the current mode showed. */
export function togglePack(state: ToolProfileState, id: CapabilityId, imageEdit = false): ToolProfileState {
  const current = effectivePacks(state, imageEdit)
  const next = current.includes(id) ? current.filter((pack) => pack !== id) : [...current, id]
  return { mode: 'custom', packs: allPackIds(imageEdit).filter((pack) => next.includes(pack)) }
}

export function readToolProfile(): ToolProfileState {
  let mode: ToolProfileId = 'compact'
  let packs: CapabilityId[] = [...COMPACT_PACKS]
  try {
    const raw = localStorage.getItem(TOOL_PROFILE_KEY)
    if (raw && (PROFILE_ORDER as readonly string[]).includes(raw)) mode = raw as ToolProfileId
    const stored: unknown = JSON.parse(localStorage.getItem(TOOL_PACKS_KEY) ?? 'null')
    if (Array.isArray(stored)) {
      const known = new Set<string>(allPackIds(true))
      packs = stored.filter((id): id is CapabilityId => typeof id === 'string' && known.has(id))
    }
  } catch {
    // Remembering the profile is a convenience only.
  }
  return { mode, packs }
}

function writeToolProfile(state: ToolProfileState): void {
  try {
    localStorage.setItem(TOOL_PROFILE_KEY, state.mode)
    localStorage.setItem(TOOL_PACKS_KEY, JSON.stringify(state.packs))
  } catch {
    // Remembering the profile is a convenience only.
  }
}

/** One line for the message context, so the Agent knows which tools and MOSS creative Skills the person enabled. */
export function toolProfileLine(state: ToolProfileState): string {
  const active = new Set(effectivePacks(state))
  const standard = active.has('skill.moss.standard')
  const layout = active.has('skill.moss.layout')
  const toolsLine = state.mode === 'custom' ? `Tools allowed: ${state.packs.join(', ') || 'none'}` : `Tools allowed: the ${state.mode} set`
  if (!standard && !layout) return toolsLine
  const skillGuidance: string[] = ['Active MOSS Creative Skills:']
  if (standard) {
    skillGuidance.push(
      '- [skill.moss.standard · 描述写法指南] Write prompts macro to micro: (1) medium/style/camera framing -> (2) environment & global lighting -> (3) subject pose/gaze/orientation -> (4) outer-to-inner attire & materials -> (5) props & 2-4 color palette. Describe visible optical/painterly traits rather than bare camera or engine names, and keep the attributes of each subject together when a pure Caption has several subjects.' +
        (!layout
          ? ' Pure Caption mode is selected: write cohesive prose via studio__board__set_prompt without region boxes unless asked.'
          : ''),
    )
  }
  if (layout) {
    skillGuidance.push(
      '- [skill.moss.layout · 分区构图指南] Spatial region mode is enabled: write global style/lighting (+ character sheet for multi-panel) in studio__board__set_prompt and place regions via studio__regions__add / studio__regions__add_text (bbox: normalized 0..1 {x,y,w,h}; never hand-write raw JSON or abs_centralized/yxyx). Use `object` (`Extreme close-up showing ONLY ...`) for inset close-ups; in text/speech bubbles put lettering/bubble geometry + pointer direction in `caption` and exact characters in `text`, then verify with studio__board__diagnose.',
    )
  }
  return `${toolsLine}\n${skillGuidance.join('\n')}`
}

export function useToolFlags() {
  const s = useApp((state) => state.settings)
  return {
    gbcEnabled: s?.gbcEnabled === true,
    trainingEnabled: s?.trainingEnabled === true,
    remoteHostsEnabled: s?.remoteHostsEnabled === true,
    workerHostsEnabled: s?.remoteHostsEnabled === true && s.workerHostsEnabled === true,
    externalImageEditEnabled: s?.externalAgentsEnabled === true && s.externalImageEditEnabled === true,
  }
}
/** The tool Skill matching a profile, built from the same registry the MCP server serves. */
export function projectedToolset(state: ToolProfileState, enabledFlags: Record<string, boolean>) {
  return projectCapabilities(BUILTIN_CAPABILITY_REGISTRY, {
    profile: state.mode,
    enabledFlags,
    ...(state.mode === 'custom' ? { enabledPacks: state.packs } : {}),
  })
}

export function useToolProfile(client: CollabClient): [ToolProfileState, (next: ToolProfileState) => void] {
  const [state, setState] = useState<ToolProfileState>(readToolProfile)
  const toast = useToast()
  const change = (next: ToolProfileState): void => {
    setState(next)
    writeToolProfile(next)
    // The MCP server follows at once, so external Agents see the new tool list on their next call.
    void client.setToolProfile(next.mode, next.packs).catch(() => toast.push('本机 MCP 服务暂时没有跟上新的工具集', 'info'))
  }
  return [state, change]
}

/**
 * The toolset control of the collab panel: one trigger showing how many packs
 * external Agents may use, opening the profile, the pack list and the copy actions.
 */
export function CollabToolbar({
  client,
  profile,
  onProfileChange,
  onOpenWizard,
}: {
  client: CollabClient
  profile: ToolProfileState
  onProfileChange: (next: ToolProfileState) => void
  /** Opens the 接入 dialog (one-click MCP install and every Skill). */
  onOpenWizard?: () => void
}): React.JSX.Element {
  const copyText = useCopyText()
  const toast = useToast()
  const flags = useToolFlags(),
    imageEdit = flags.externalImageEditEnabled
  const rows = listPackRows(imageEdit)
  const ticked = new Set(effectivePacks(profile, imageEdit))

  return (
    <Popover
      align="end"
      role="dialog"
      label="工具集"
      className="w-[min(19rem,calc(100vw-3rem))] gap-1 p-2"
      trigger={(menu) => (
        <button
          type="button"
          onClick={menu.toggle}
          aria-expanded={menu['aria-expanded']}
          aria-controls={menu['aria-controls']}
          aria-haspopup={menu['aria-haspopup']}
          title={`外部 Agent 能用的工具：${PROFILE_LABELS[profile.mode]}，${ticked.size}/${rows.length} 个工具包`}
          data-tool-packs
          className={cn(
            'inline-flex h-[26px] shrink-0 items-center gap-1 rounded-md px-1.5 text-micro text-ink-2 transition-colors hover:bg-well-strong hover:text-ink',
            menu.open && 'bg-well-strong text-ink',
          )}
        >
          <Boxes className="size-3.5" aria-hidden="true" strokeWidth={1.6} />
          <span>工具集</span>
          <span className="tabular">
            {ticked.size}/{rows.length}
          </span>
          <ChevronDown className="size-3 text-ink-3" aria-hidden="true" strokeWidth={1.6} />
        </button>
      )}
    >
      {() => (
        <>
          <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1">
            <Select
              aria-label="协同工具集"
              value={profile.mode}
              onValueChange={(value) => {
                const mode = (PROFILE_ORDER as readonly string[]).includes(value) ? (value as ToolProfileId) : 'compact'
                onProfileChange({ mode, packs: mode === 'custom' && !profile.packs.length ? [...COMPACT_PACKS] : profile.packs })
              }}
              className="h-7 min-w-0 flex-1 text-ui"
            >
              {PROFILE_ORDER.map((mode) => (
                <option key={mode} value={mode}>
                  {PROFILE_LABELS[mode]}
                </option>
              ))}
            </Select>
            <Button size="xs" tone="ghost" onClick={() => onProfileChange({ mode: 'custom', packs: allPackIds(imageEdit) })}>
              全选
            </Button>
            <Button size="xs" tone="ghost" onClick={() => onProfileChange({ mode: 'custom', packs: [...COMPACT_PACKS] })}>
              精简
            </Button>
          </div>
          <span className="px-1 text-caption text-ink-2">勾选后立即生效</span>
          <div className="flex max-h-[min(45vh,22rem)] flex-col overflow-y-auto">
            {rows.map((row) => (
              <Checkbox
                key={row.id}
                checked={ticked.has(row.id)}
                onCheckedChange={() => onProfileChange(togglePack(profile, row.id, imageEdit))}
                label={row.title}
                description={row.isSkill ? '给 Agent 的写法指南' : `${row.actionCount} 项动作`}
                className="gap-2 rounded-md px-2 py-1.5"
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1 px-1 pt-1.5">
            <Button
              tone="ghost"
              size="xs"
              data-copy-workbench-skill
              title="复制与当前工具集一致的 Skill 说明"
              onClick={() => {
                const projected = projectedToolset(profile, flags)
                void copyText(
                  projected.skill.markdown,
                  `已复制 ${PROFILE_LABELS[profile.mode]} Skill（${projected.actions.length} 项能力）`,
                )
              }}
            >
              <Copy className="size-3" aria-hidden="true" strokeWidth={1.6} />
              Skill
            </Button>
            <Button
              tone="ghost"
              size="xs"
              data-copy-mcp-config
              title="复制给外部 Agent 用的 MCP 连接配置"
              onClick={() => {
                void client.mcpConnection().then((connection) => {
                  if (!connection) {
                    toast.push('本机 MCP 服务未启动', 'error')
                    return
                  }
                  return copyText(mcpConfigJson(connection), `已复制 MCP 连接配置（${connection.toolCount} 个工具）`)
                })
              }}
            >
              <Plug className="size-3" aria-hidden="true" strokeWidth={1.6} />
              MCP
            </Button>
            {onOpenWizard ? (
              <Button tone="ghost" size="xs" className="ml-auto" onClick={onOpenWizard}>
                接入向导…
              </Button>
            ) : null}
          </div>
        </>
      )}
    </Popover>
  )
}
