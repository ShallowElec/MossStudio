/**
 * The opt-in features of PR #124: 外部 Agent (the 协同 panel, connecting Codex
 * and Claude Code, approvals from any page) and Worker 远程主机, both off until
 * turned on in 设置 › 功能; and LoRA trigger words in the 画面's LoRA rows.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { useApp, type E2eApp } from '../support/app'
import { openCollab, openLoraRows, seedLoraBoard } from '../support/board'

async function openStudio(app: E2eApp, scenario: 'ready' | 'externalAgents' | 'workerHost'): Promise<Page> {
  const page = await app.open({ scenario, route: '/studio', defer: true })
  await seedLoraBoard(page, { workerHost: scenario === 'workerHost' })
  await app.start()
  await page.locator('article[data-canvas-card="c1"]').first().waitFor()
  return page
}

describe('optional features are off by default', () => {
  const app = useApp()

  it('shows no 协同, no approval overlay, no MCP and no Worker mode until switched on', async () => {
    const page = await openStudio(app, 'ready')
    // Even with a request waiting in main, nothing about external Agents shows.
    await page.evaluate(() => {
      window.__mock.state.agents.approvals = [
        {
          id: 'a1',
          actionId: 'studio.projects.delete',
          packId: 'studio.projects',
          title: '删除项目',
          summary: '删除项目 旧海报',
          argsPreview: '{}',
          source: 'external-agent',
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      ]
    })
    await page.getByRole('button', { name: '助手', exact: true }).click()
    await page.getByRole('group', { name: '助手模式' }).waitFor()
    expect(await page.locator('[data-collab-toggle]').count()).toBe(0)
    expect(await page.locator('[data-global-approval-overlay]').count()).toBe(0)
    expect(await app.calls('mcp:info')).toEqual([])
    expect(await app.calls('agent-hub:approvals')).toEqual([])

    await page.evaluate(() => {
      window.location.hash = '#/settings/features'
    })
    expect(await page.getByRole('switch', { name: '外部 Agent' }).getAttribute('aria-checked')).toBe('false')
    // Worker hosts live under 远程主机: their switch shows only once that is on.
    expect(await page.getByRole('switch', { name: 'Worker 远程主机' }).count()).toBe(0)
  })

  it('has no Worker mode in the host dialog while Worker 远程主机 is off', async () => {
    const page = await app.open({ scenario: 'remoteHost', route: '/settings/devices', settings: { remoteHostsEnabled: true } })
    await page.getByRole('button', { name: /添加 SSH 主机/ }).click()
    const dialog = page.getByRole('dialog', { name: '添加 SSH 主机' })
    await dialog.waitFor()
    expect(await dialog.getByRole('group', { name: '运行方式' }).count()).toBe(0)
  })

  it('turning 外部 Agent on saves the switch and brings the 协同 button', async () => {
    const page = await app.open({ scenario: 'ready', route: '/settings/features' })
    await page.getByRole('switch', { name: '外部 Agent' }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ externalAgentsEnabled: true })
    await page.getByRole('switch', { name: '远程主机', exact: true }).click()
    await expect.poll(() => page.getByRole('switch', { name: 'Worker 远程主机' }).count()).toBe(1)
    await page.evaluate(() => {
      window.location.hash = '#/studio'
    })
    await page.getByRole('button', { name: '助手', exact: true }).click()
    await expect.poll(() => page.locator('[data-collab-toggle]').count()).toBe(1)
  })
})

describe('外部 Agent on', () => {
  const app = useApp()

  it('the 协同 panel shows the project’s conversation and connects Codex from one dialog', async () => {
    const page = await openStudio(app, 'externalAgents')
    await openCollab(page)
    const panel = page.locator('[data-collab-panel]')
    await expect.poll(() => panel.getByText('画一张海边的海报').isVisible()).toBe(true)
    await expect.poll(() => panel.getByText('好的，已经新建画面并开始生成。').isVisible()).toBe(true)

    await panel.locator('[data-mcp-wizard]').click()
    const dialog = page.getByRole('dialog', { name: '接入外部 Agent' })
    await dialog.waitFor()
    await expect.poll(() => dialog.locator('[data-mcp-client="codex"]').getAttribute('data-mcp-client-state')).toBe('installed')
    expect(await dialog.locator('[data-mcp-copy-client="claude-code"]').count()).toBe(1)
    await dialog.locator('[data-mcp-uninstall="codex"]').click()
    await expect.poll(() => app.calls('mcp:client-uninstall')).toEqual([{ clientId: 'codex' }])
    await expect.poll(() => dialog.locator('[data-mcp-install="codex"]').textContent()).toContain('连接')
  })

  it('an Agent’s request can be answered from any page', async () => {
    const page = await app.open({ scenario: 'externalAgents', route: '/library' })
    const overlay = page.locator('[data-global-approval-overlay]')
    await expect.poll(() => overlay.getByText('删除项目 旧海报').isVisible()).toBe(true)
    await overlay.getByRole('button', { name: '拒绝' }).click()
    await expect.poll(() => app.calls('agent-hub:resolve-approval')).toEqual([{ id: 'approval-1', decision: 'reject' }])
    await expect.poll(() => overlay.count()).toBe(0)
  })
})

describe('LoRA trigger words', () => {
  const app = useApp()

  it('a LoRA row shows its trigger word, and a click writes it into the description and takes it out again', async () => {
    const page = await openStudio(app, 'ready')
    await openLoraRows(page)
    const chip = page.locator('[data-lora-triggers="local-lora-ink"] [data-trigger-chip="ink style"]')
    await chip.waitFor()
    expect(await chip.getAttribute('data-trigger-state')).toBe('out')
    await chip.click()
    await expect.poll(() => chip.getAttribute('data-trigger-state')).toBe('in')
    await chip.click()
    await expect.poll(() => chip.getAttribute('data-trigger-state')).toBe('out')
  })
})

describe('Worker 远程主机 on', () => {
  const app = useApp()

  it('the host dialog offers the Worker mode with its own fields', async () => {
    const page = await app.open({ scenario: 'workerHost', route: '/settings/devices' })
    await page.getByRole('button', { name: 'GPU Worker 更多操作' }).click()
    await page.getByRole('menuitem', { name: '编辑' }).click()
    const dialog = page.getByRole('dialog', { name: '编辑 SSH 主机' })
    await dialog.waitFor()
    expect(await dialog.getByRole('group', { name: '运行方式' }).count()).toBe(1)
    expect(await dialog.getByLabel('服务信息文件').inputValue()).toBe('/srv/worker/discovery.json')
  })

  it('the LoRA picker lists the Worker’s own LoRA when it is the 运行位置', async () => {
    const page = await openStudio(app, 'workerHost')
    await openLoraRows(page)
    await page.locator('[data-adapter-picker]').first().click()
    const dialog = page.getByRole('dialog', { name: '选择 LoRA · GPU Worker' })
    await dialog.waitFor()
    await expect.poll(() => dialog.getByText('ink.safetensors').first().isVisible()).toBe(true)
  })
})
