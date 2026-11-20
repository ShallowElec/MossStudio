import { useEffect, useState } from 'react'
import type { AiProviderInfo } from '@shared/ai'
import { Events, Ipc } from '@shared/channels'
import { call, onEvent } from './api'

/** The connected language models, read again whenever one is connected, edited or removed anywhere. */
export function useProviders(): { providers: AiProviderInfo[]; loaded: boolean } {
  const [providers, setProviders] = useState<AiProviderInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    const read = (): void => {
      call<AiProviderInfo[]>(Ipc.aiProvidersList)
        .then((list) => {
          if (alive) setProviders(list)
        })
        .catch(() => undefined) // keep the list on screen
        .finally(() => {
          if (alive) setLoaded(true)
        })
    }
    read()
    // The event carries no list (it also reaches the LAN page), so ask again.
    const off = onEvent(Events.aiProviders, read)
    return () => {
      alive = false
      off()
    }
  }, [])
  return { providers, loaded }
}
