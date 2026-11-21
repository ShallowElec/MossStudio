import type { Settings } from '@shared/types'

/** Optional features. Each is off by default and turned on in 设置 › 功能. */
export type FeatureKey =
  'remoteHostsEnabled' | 'workerHostsEnabled' | 'trainingEnabled' | 'gbcEnabled' | 'lanWebEnabled' | 'externalAgentsEnabled'

export interface FeatureInfo {
  key: FeatureKey
  label: string
  description: string
  /** Shown, and in effect, only while this other feature is on. */
  within?: FeatureKey
}

export const FEATURES: FeatureInfo[] = [
  {
    key: 'remoteHostsEnabled',
    label: '远程主机',
    description: '把生成和训练放到一台通过 SSH 连接的 NVIDIA 电脑上运行。',
  },
  {
    key: 'workerHostsEnabled',
    label: 'Worker 远程主机',
    description: '也能添加运行 Worker 服务的远程电脑，用它自己的模型和 LoRA 生成。试验中。',
    within: 'remoteHostsEnabled',
  },
  {
    key: 'trainingEnabled',
    label: '训练',
    description: '用自己的图片训练 LoRA，训练好的 LoRA 可以直接在创作中使用。',
  },
  {
    key: 'gbcEnabled',
    label: '看图拆区域',
    description: '把一张图拆成带描述的区域，照它的布局再画一张。',
  },
  {
    key: 'lanWebEnabled',
    label: '局域网访问',
    description: '同一网络下的手机或电脑可以用浏览器打开创作页。',
  },
  {
    key: 'externalAgentsEnabled',
    label: '外部 Agent',
    description: '让 Codex、Claude Code 等 Agent 通过 MCP 在创作页上画图，并在助手旁协同。',
  },
]

export function featureEnabled(settings: Pick<Settings, FeatureKey> | null | undefined, key: FeatureKey): boolean {
  const within = FEATURES.find((feature) => feature.key === key)?.within
  return Boolean(settings?.[key]) && (!within || featureEnabled(settings, within))
}

/** Which optional areas of the app should appear at all. */
export function featureVisibility(settings: Pick<Settings, FeatureKey> | null | undefined): {
  remoteHosts: boolean
  workerHosts: boolean
  training: boolean
  gbc: boolean
  lan: boolean
  externalAgents: boolean
} {
  return {
    remoteHosts: featureEnabled(settings, 'remoteHostsEnabled'),
    workerHosts: featureEnabled(settings, 'workerHostsEnabled'),
    training: featureEnabled(settings, 'trainingEnabled'),
    gbc: featureEnabled(settings, 'gbcEnabled'),
    lan: featureEnabled(settings, 'lanWebEnabled'),
    externalAgents: featureEnabled(settings, 'externalAgentsEnabled'),
  }
}
