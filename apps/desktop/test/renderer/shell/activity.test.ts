import { describe, expect, it } from 'vitest'
import { solutionTarget } from '@renderer/components/shell/ActivityPanel'
import shipped from '../../../resources/rules.json'

describe('solutionTarget', () => {
  it('opens the settings section a rule names', () => {
    expect(solutionTarget({ label: '换镜像', action: 'open_settings', params: { tab: 'network' } })).toEqual({ route: '/settings/network' })
    expect(solutionTarget({ label: '改位置', action: 'open_settings', params: { tab: 'storage' } })).toEqual({ route: '/settings/storage' })
  })

  it('falls back to Settings for a missing or odd section name', () => {
    expect(solutionTarget({ label: '设置', action: 'open_settings' })).toEqual({ route: '/settings' })
    expect(solutionTarget({ label: '设置', action: 'open_settings', params: { tab: '../x' } })).toEqual({ route: '/settings' })
    expect(solutionTarget({ label: '设置', action: 'open_settings', params: { tab: 3 } })).toEqual({ route: '/settings' })
  })

  it('maps job logs, models, engine fixes and copying', () => {
    expect(solutionTarget({ label: '日志', action: 'open_job_log' })).toEqual({ job: true })
    expect(solutionTarget({ label: '日志', action: 'open_log' })).toEqual({ job: true })
    expect(solutionTarget({ label: '模型', action: 'models' })).toEqual({ route: '/models' })
    expect(solutionTarget({ label: '引擎', action: 'repair_runtime' })).toEqual({ route: '/settings/devices' })
    expect(solutionTarget({ label: '复制', action: 'copy_diagnostics' })).toEqual({ copy: true })
  })

  it('hides actions that have no real fix', () => {
    expect(solutionTarget({ label: '降低设置重试', action: 'retry_lower' })).toBeNull()
    expect(solutionTarget({ label: '?', action: 'something_new' })).toBeNull()
  })

  it('every fix the shipped rules suggest is one the app can carry out', () => {
    const solutions = shipped.rules.flatMap((rule) => rule.solutions.map((solution) => ({ rule: rule.id, ...solution })))
    expect(solutions.filter((solution) => !solutionTarget(solution)).map((solution) => `${solution.rule}: ${solution.action}`)).toEqual([])
  })

  it('words the shipped rules for people, without engine internals', () => {
    const text = shipped.rules.map((rule) => `${rule.title} ${rule.explain} ${rule.solutions.map((solution) => solution.label).join(' ')}`)
    expect(text.filter((line) => /DMD|bf16|MPS|Python|HF |实例|镜像/.test(line))).toEqual([])
  })
})
