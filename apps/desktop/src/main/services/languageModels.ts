import { languageProvider, type AiProviderInfo, type AiProviderInput } from '@shared/ai'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { complete, listProviders, providersChanged, removeProvider, saveProvider } from './ai'
import { getSettings, updateSettings } from './settings'

/**
 * Who does what among the connected language models (设置 › 语言模型). Lives
 * apart from `ai.ts` because it reads settings, and settings read `ai.ts` for
 * their migration.
 */

/** The connection for 助手和漫画: the one chosen in 设置, else the first connected. */
export function defaultLanguageProviderId(): string | undefined {
  return languageProvider(listProviders(), getSettings().languageProviderId)?.id
}

/**
 * Connect or edit a model. With nothing chosen for 助手和漫画, the one in effect
 * becomes the choice (the new one when it is the first): the list puts the newest
 * first, so connecting another would otherwise quietly take over.
 */
export function connectProvider(input: AiProviderInput): AiProviderInfo {
  const before = listProviders()
  const saved = saveProvider(input)
  const chosen = getSettings().languageProviderId
  if (!before.some((provider) => provider.id === chosen)) {
    emit(Events.settingsChanged, updateSettings({ languageProviderId: before[0]?.id ?? saved.id }))
  }
  providersChanged()
  return saved
}

export function disconnectProvider(id: string): void {
  removeProvider(id)
  providersChanged()
}

/** `ai:complete`: a request that names no model (a 漫画 series that never picked one) goes to 助手和漫画. */
export function completeWithDefault(input: { providerId?: string; system: string; prompt: string }): Promise<string> {
  return complete({ ...input, providerId: input.providerId ?? defaultLanguageProviderId() })
}
