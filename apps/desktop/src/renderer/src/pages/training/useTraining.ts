import { useCallback, useEffect, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { TrainingProject, TrainingReadiness } from '@shared/training'
import type { ManagedHost } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { TRAINING_HOST_EVENT, announceTrainingHost, getSelectedTrainingHost, resolveTrainingHost } from '../../lib/trainingHost'
import { useApp } from '../../store'

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Remembered conveniences (高级 open, grid or list); storage may be unavailable. */
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A preference that cannot be kept is only forgotten next time.
  }
}

/** Where training runs: 本机, or an SSH computer while 远程电脑 is turned on. */
export function useTrainingHost(): { hostId: string; sshHosts: ManagedHost[]; setHostId: (id: string) => void } {
  const remoteHostsEnabled = useApp((state) => state.settings?.remoteHostsEnabled ?? false)
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  const [selected, setSelected] = useState(getSelectedTrainingHost)

  useEffect(() => {
    if (!remoteHostsEnabled) {
      setHosts([])
      return
    }
    const load = (): void => {
      void call<ManagedHost[]>(Ipc.hostsList)
        .then(setHosts)
        .catch(() => setHosts([]))
    }
    load()
    return onEvent(Events.hostsChanged, load)
  }, [remoteHostsEnabled])

  useEffect(() => {
    const sync = (): void => setSelected(getSelectedTrainingHost())
    window.addEventListener(TRAINING_HOST_EVENT, sync)
    return () => window.removeEventListener(TRAINING_HOST_EVENT, sync)
  }, [])

  const setHostId = useCallback((id: string) => {
    announceTrainingHost(id)
    setSelected(id)
  }, [])

  const sshHosts = hosts.filter((host) => host.kind === 'ssh')
  return { hostId: resolveTrainingHost(selected, sshHosts, remoteHostsEnabled), sshHosts, setHostId }
}

/**
 * What a location has for training. `undefined` while reading, `null` when it
 * could not be read (`error` says why). Preparing pushes every step.
 */
export function useReadiness(hostId: string | null): {
  readiness: TrainingReadiness | null | undefined
  error: string | null
  refresh: () => Promise<void>
} {
  const [readiness, setReadiness] = useState<TrainingReadiness | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!hostId) return
    try {
      setReadiness(await call<TrainingReadiness>(Ipc.trainingReadiness, { hostId }))
      setError(null)
    } catch (reason) {
      setReadiness(null)
      setError(errorText(reason))
    }
  }, [hostId])

  useEffect(() => {
    setReadiness(undefined)
    void refresh()
  }, [refresh])

  useEffect(
    () =>
      onEvent<TrainingReadiness>(Events.trainingReadinessChanged, (next) => {
        if (next.hostId === hostId) setReadiness(next)
      }),
    [hostId],
  )

  return { readiness, error, refresh }
}

/** Every training, newest first; kept current by `trainingChanged`. `undefined` while reading. */
export function useTrainings(): {
  trainings: TrainingProject[] | undefined
  refresh: () => Promise<void>
  upsert: (project: TrainingProject) => void
  drop: (id: string) => void
} {
  const [trainings, setTrainings] = useState<TrainingProject[] | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      setTrainings(await call<TrainingProject[]>(Ipc.trainingList))
    } catch {
      // The list stays as it was; the page shows what it has.
      setTrainings((previous) => previous ?? [])
    }
  }, [])

  const upsert = useCallback((project: TrainingProject) => {
    setTrainings((previous) => {
      const list = previous ?? []
      return list.some((item) => item.id === project.id)
        ? list.map((item) => (item.id === project.id ? project : item))
        : [project, ...list]
    })
  }, [])

  const drop = useCallback((id: string) => {
    setTrainings((previous) => previous?.filter((item) => item.id !== id))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => onEvent<TrainingProject>(Events.trainingChanged, upsert), [upsert])

  return { trainings, refresh, upsert, drop }
}
