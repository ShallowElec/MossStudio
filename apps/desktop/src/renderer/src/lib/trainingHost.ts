import type { ManagedHost } from '@shared/types'
/**
 * Where training runs: 'local' or the id of an SSH host. Remembered per person
 * in localStorage; views that show it hear about changes through TRAINING_HOST_EVENT.
 */
const KEY = 'mossstudio:training-host'

export const TRAINING_HOST_EVENT = 'mossstudio:training-host-changed'

/** The hosts a training can run on: SSH hosts, but never a Worker host, which only generates pictures. */
export function trainingSshHosts<T extends Pick<ManagedHost, 'kind' | 'remoteBackend'>>(hosts: readonly T[]): T[] {
  return hosts.filter((host) => host.kind === 'ssh' && host.remoteBackend !== 'worker-daemon')
}

export function getSelectedTrainingHost(): string {
  try {
    return localStorage.getItem(KEY) || 'local'
  } catch {
    return 'local'
  }
}

export function setSelectedTrainingHost(id: string): void {
  try {
    localStorage.setItem(KEY, id || 'local')
  } catch {
    /* storage unavailable */
  }
}

export function announceTrainingHost(id: string): void {
  setSelectedTrainingHost(id)
  window.dispatchEvent(new CustomEvent(TRAINING_HOST_EVENT, { detail: id }))
}

/**
 * The location actually in use. Remote hosts only count while the remote-hosts
 * feature is on and the host still exists; otherwise training runs locally.
 */
export function resolveTrainingHost(
  id: string | null | undefined,
  hosts: ReadonlyArray<{ id: string; kind: string }>,
  remoteHostsEnabled: boolean,
): string {
  if (!id || id === 'local' || !remoteHostsEnabled) return 'local'
  return hosts.some((host) => host.id === id && host.kind === 'ssh') ? id : 'local'
}
