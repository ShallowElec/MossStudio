import { useEffect, useState } from 'react'
import type { AiProviderInfo } from '@shared/ai'
import { Events, Ipc } from '@shared/channels'
import { call, onEvent } from './api'

/** The connected language models, kept current when one is connected, edited or removed anywhere. */
export function useProviders(): { providers: AiProviderInfo[]; loaded: boolean } {
  const [providers, setProviders] = useState<AiProviderInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    call<AiProviderInfo[]>(Ipc.aiProvidersList)
      .then((list) => {
        if (alive) setProviders(list)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoaded(true)
      })
    const off = onEvent<AiProviderInfo[]>(Events.aiProviders, (list) => {
      setProviders(list)
      setLoaded(true)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return { providers, loaded }
}
