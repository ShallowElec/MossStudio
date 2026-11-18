import { useMemo, useRef } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- callbacks of any shape pass through unchanged
type Callback = (...args: any[]) => unknown

export interface StableCallbacks {
  /**
   * Called on every render with fresh closures; returns the same function for
   * the same key and name every time, which runs the latest closure.
   */
  bind: <T extends Record<string, Callback>>(key: string, handlers: T) => T
  /** Forget every key not in `keys` (cards that left the board), with the closures they hold. */
  retain: (keys: Iterable<string>) => void
}

/**
 * Callbacks that keep their identity across renders yet always run the
 * latest version handed in. A memoized card can then skip a render without
 * holding closures over stale board state.
 */
export function useStableCallbacks(): StableCallbacks {
  const latest = useRef(new Map<string, Record<string, Callback>>())
  const stable = useRef(new Map<string, Record<string, Callback>>())
  return useMemo(
    () => ({
      bind: <T extends Record<string, Callback>>(key: string, handlers: T): T => {
        latest.current.set(key, handlers)
        let bound = stable.current.get(key)
        if (!bound) {
          bound = {}
          stable.current.set(key, bound)
        }
        for (const name of Object.keys(handlers)) {
          bound[name] ??= (...args: unknown[]) => latest.current.get(key)?.[name]?.(...args)
        }
        return bound as T
      },
      retain: (keys: Iterable<string>) => {
        const keep = new Set(keys)
        for (const key of [...latest.current.keys()]) if (!keep.has(key)) latest.current.delete(key)
        for (const key of [...stable.current.keys()]) if (!keep.has(key)) stable.current.delete(key)
      },
    }),
    [],
  )
}
