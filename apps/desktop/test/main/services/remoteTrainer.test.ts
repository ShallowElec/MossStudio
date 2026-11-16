import { describe, expect, it } from 'vitest'
import { rootExpression } from '@main/services/remoteTrainer'

describe('remote paths in shell commands', () => {
  it('expands only the home folder of a ~/ path and quotes the rest as written', () => {
    expect(rootExpression('~')).toBe('"$HOME"')
    expect(rootExpression('~/models')).toBe(`"$HOME"/'models'`)
    expect(rootExpression('~/a $b `c` \\d "e"')).toBe(`"$HOME"/'a $b \`c\` \\d "e"'`)
    expect(rootExpression("~/it's")).toBe(`"$HOME"/'it'\\''s'`)
    expect(rootExpression('/srv/$x')).toBe(`'/srv/$x'`)
  })
})
