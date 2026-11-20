import { describe, expect, it } from 'vitest'
import { solutionTarget } from '@renderer/components/shell/ActivityPanel'
import shipped from '../../../resources/rules.json'
import { SETTINGS_SECTIONS } from '@renderer/pages/settings/sections'

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

  it('every place a shipped rule sends people to is a real settings section', () => {
    const sections = new Set(SETTINGS_SECTIONS.map((section) => `/settings/${section.id}`))
    const routes = shipped.rules.flatMap((rule) => rule.solutions.map((solution) => solutionTarget(solution)?.route)).filter(Boolean)
    expect(routes.filter((route) => !sections.has(route!))).toEqual([])
  })

  it('a training environment that is incomplete or out of step leads to where it is reinstalled', () => {
    for (const id of ['E_MODULE', 'E_VERSION']) {
      const rule = shipped.rules.find((item) => item.id === id)!
      expect(rule.solutions.map((solution) => solutionTarget(solution)?.route)).toContain('/settings/training')
      expect(rule.explain).toContain('设置 › 训练')
    }
  })

  it('words memory failures for a picture and a training alike, since both fire them', () => {
    for (const id of ['E_OOM', 'E_KILLED']) {
      const { explain } = shipped.rules.find((item) => item.id === id)!
      expect(explain).not.toMatch(/^这张图/)
      expect(explain).toMatch(/生成时/)
    }
    expect(shipped.rules.find((item) => item.id === 'E_OOM')!.explain).toContain('训练时')
  })
})
