/**
 * Structural equality for plain data: primitives, arrays, plain objects, Maps
 * and Sets. Functions and every other object compare by identity, so a
 * memoized component still re-renders when it is handed a new callback.
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameData(item, b[index]))
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false
    for (const [key, value] of a) if (!b.has(key) || !sameData(value, b.get(key))) return false
    return true
  }
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false
    for (const value of a) if (!b.has(value)) return false
    return true
  }
  if (!isPlain(a) || !isPlain(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  return keys.every((key) => Object.hasOwn(right, key) && sameData(left[key], right[key]))
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}
