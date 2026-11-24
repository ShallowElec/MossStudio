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
    await expect.poll(() => dialog.locator('[data-mcp-client="codex"]').getAttribute('data-mcp-client-state')).toBe('configured')
    await expect.poll(() => dialog.locator('[data-mcp-client="dsh"]').textContent()).toContain('检测到本机 DSH 环境')
    expect(await dialog.locator('[data-mcp-client]').first().getAttribute('data-mcp-client')).toBe('dsh')
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            document.body.dataset.copied = text
          },
        },
      }),
    )
    expect(await dialog.getByRole('heading', { name: '本机客户端' }).isVisible()).toBe(true)
    expect(await dialog.locator('[data-mcp-client="dsh"]').textContent()).toContain('手动')
    await dialog.getByRole('button', { name: '复制 DSH stdio 配置' }).click()
    expect(await app.calls('mcp:client-install')).toEqual([])
    await expect
      .poll(() => page.evaluate(() => JSON.parse(document.body.dataset.copied ?? '{}')))
      .toMatchObject({ serverName: 'mossstudio', transport: 'stdio', command: '/fixture/bin/node', toolCallTimeoutMs: 180000 })
    await expect.poll(() => app.calls('mcp:info').then((calls) => calls.at(-1))).toEqual({ includeToken: true })
    expect(await dialog.locator('[data-mcp-copy-client="claude-code"]').count()).toBe(1)
    await dialog.locator('[data-mcp-uninstall="codex"]').click()
    await expect.poll(() => app.calls('mcp:client-uninstall')).toEqual([{ clientId: 'codex' }])
    await expect.poll(() => dialog.locator('[data-mcp-install="codex"]').textContent()).toContain('一键配置')
    await dialog.locator('[data-mcp-install="codex"]').click()
    await expect.poll(() => dialog.locator('[data-mcp-client="codex"]').textContent()).toContain('已配置')
  })

  it('resets a protected Codex configuration only after confirming the reconnect', async () => {
    const page = await openStudio(app, 'externalAgents')
    await page.evaluate(() => {
      const codex = window.__mock.state.agents.clients.find((client) => client.id === 'codex')!
      codex.state = 'custom_policy'
      codex.detail = 'Codex 已禁用此服务，已限制可用工具，未自动覆盖。'
    })
    await openCollab(page)
    await page.locator('[data-mcp-wizard]').click()
    const dialog = page.getByRole('dialog', { name: '接入外部 Agent' })
    const reconnect = dialog.getByRole('button', { name: '重新连接', exact: true })
    await reconnect.click()
    const confirm = page.getByRole('dialog', { name: '重置 Codex 连接？' })
    expect(await confirm.textContent()).toContain('清除工具限制')
    await confirm.getByRole('button', { name: '取消' }).click()
    expect(await app.calls('mcp:client-install')).toEqual([])
    await reconnect.click()
    await confirm.getByRole('button', { name: '重置并重新连接' }).click()
    await expect.poll(() => app.calls('mcp:client-install')).toEqual([{ clientId: 'codex', resetPolicy: true }])
    await expect.poll(() => dialog.locator('[data-mcp-client="codex"]').textContent()).toContain('已配置')
  })

  it('offers one click back when an Agent’s connection drops, and stops saying it is there', async () => {
    const page = await openStudio(app, 'externalAgents')
    await openCollab(page)
    const panel = page.locator('[data-collab-panel]')
    const status = panel.locator('[data-collab-status]')
    await expect.poll(() => status.getAttribute('data-activity')).toBe('idle')
    expect(await panel.locator('[data-collab-reconnect]').count()).toBe(0)

    // The Agent's process exits: the next send fails, and the hub now says it is not connected.
    await page.evaluate(() => {
      window.__mock.state.agents.sendError = 'Agent 进程已退出'
      window.__mock.state.agents.backends = window.__mock.state.agents.backends.map((item) => ({ ...item, connected: false }))
    })
    await panel.getByLabel('发给 Codex 的消息').fill('你好')
    await panel.getByRole('button', { name: '发给 Codex', exact: true }).click()
    const notice = panel.locator('[data-notice="warn"]')
    await expect.poll(() => notice.textContent()).toContain('Agent 进程已退出')
    await expect.poll(() => status.getAttribute('data-activity')).toBe('offline')

    await notice.locator('[data-collab-reconnect]').click()
    await expect.poll(() => app.calls('agent-hub:connect')).toEqual([{ backendId: 'codex-acp' }])
    await expect.poll(() => panel.locator('[data-notice="warn"]').count()).toBe(0)
  })

  it('an Agent’s request can be answered from any page', async () => {
    const page = await app.open({ scenario: 'externalAgents', route: '/library' })
    const overlay = page.locator('[data-global-approval-overlay]')
    await expect.poll(() => overlay.getByText('删除项目 旧海报').isVisible()).toBe(true)
    await overlay.getByRole('button', { name: '拒绝' }).click()
    await expect.poll(() => app.calls('agent-hub:resolve-approval')).toEqual([{ id: 'approval-1', decision: 'reject' }])
    await expect.poll(() => overlay.count()).toBe(0)
  })

  it('the 工具集 popover keeps both guides off until a preset or a tick turns them on', async () => {
    const page = await openStudio(app, 'externalAgents')
    await openCollab(page)
    const panel = page.locator('[data-collab-panel]')
    await panel.locator('[data-tool-packs]').click()
    const dialog = page.getByRole('dialog', { name: '工具集' })
    await dialog.waitFor()
    await expect.poll(() => dialog.getByText('描述写法指南').isVisible()).toBe(true)
    await expect.poll(() => dialog.getByText('分区构图指南').isVisible()).toBe(true)
    await expect.poll(() => dialog.getByRole('checkbox', { name: /描述写法指南/ }).isChecked()).toBe(false)
    await expect.poll(() => dialog.getByRole('checkbox', { name: /分区构图指南/ }).isChecked()).toBe(false)

    const profileSelect = dialog.getByLabel('协同工具集')
    await profileSelect.selectOption('moss-standard')
    await expect.poll(() => app.calls('mcp:set-profile').then((calls) => calls.at(-1))).toEqual({ profile: 'moss-standard' })
    await expect.poll(() => dialog.getByRole('checkbox', { name: /描述写法指南/ }).isChecked()).toBe(true)
    await expect.poll(() => dialog.getByRole('checkbox', { name: /分区构图指南/ }).isChecked()).toBe(false)

    await profileSelect.selectOption('moss-layout')
    await expect.poll(() => app.calls('mcp:set-profile').then((calls) => calls.at(-1))).toEqual({ profile: 'moss-layout' })
    await expect.poll(() => dialog.getByRole('checkbox', { name: /分区构图指南/ }).isChecked()).toBe(true)
  })

  it('connects DSH Desktop with a local pairing URL and scopes conversations by workspace', async () => {
    const page = await app.open({ scenario: 'externalAgents', route: '/studio', defer: true })
    await seedLoraBoard(page, { workerHost: false })
    await page.evaluate(() => {
      localStorage.removeItem('mossstudio.collab.backend')
      window.__mock.state.agents.backends = [
        {
          id: 'dsh-desktop',
          label: 'DSH Desktop',
          kind: 'dsh-desktop',
          available: true,
          preferred: true,
          connected: false,
          resumable: true,
        },
        { id: 'codex-acp', label: 'Codex ACP', kind: 'acp', available: true, connected: false },
      ]
      window.__mock.state.agents.projects = [
        { id: 'ws-1', title: 'Poster', cwd: 'F:\\work\\poster', sessionIds: ['session-1'] },
        { id: 'ws-empty', title: 'Empty', cwd: 'F:\\work\\empty', sessionIds: [] },
      ]
    })
    await app.start()
    await page.locator('article[data-canvas-card="c1"]').first().waitFor()
    await openCollab(page)
    const panel = page.locator('[data-collab-panel]')
    await panel.getByLabel('本机配对地址').fill('http://127.0.0.1:52497/?token=demo_token')
    await panel.getByRole('button', { name: '连接 DSH Desktop' }).click()
    await expect
      .poll(() => app.calls('agent-hub:connect').then((calls) => calls.at(-1)))
      .toEqual({ backendId: 'dsh-desktop', pairingUrl: 'http://127.0.0.1:52497/?token=demo_token' })
    const workspaceSelect = panel.getByLabel('DSH 工作区')
    await workspaceSelect.waitFor()
    await workspaceSelect.selectOption('ws-1')
    await expect.poll(() => panel.getByText('画一张海边的海报').isVisible()).toBe(true)
    await workspaceSelect.selectOption('ws-empty')
    await expect.poll(() => panel.getByLabel('工作区对话').isDisabled()).toBe(true)
  })

  it('the model list is headed by its provider, and one id from two providers stays pickable', async () => {
    const page = await openStudio(app, 'externalAgents')
    await page.evaluate(() => {
      window.__mock.state.agents.models = [
        { id: 'solo', label: 'solo' },
        { id: 'shared', label: 'shared · alpha', provider: 'alpha' },
        { id: 'shared', label: 'shared · beta', provider: 'beta' },
      ]
    })
    await openCollab(page)
    const select = page.locator('[data-model-picker] select[aria-label="会话模型"]')
    await select.waitFor()
    // A model without a provider comes first, then one heading per provider; the
    // provider is no longer repeated inside every entry.
    expect(await select.locator('optgroup').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('label')))).toEqual([
      'alpha',
      'beta',
    ])
    expect(await select.locator('option').evaluateAll((nodes) => nodes.map((node) => node.textContent))).toEqual([
      '选择模型',
      'solo',
      'shared',
      'shared',
      '手动输入…',
    ])
    // The second `shared` is beta's: picking it must send that provider, not the first one found by id.
    await select.selectOption({ index: 3 })
    await expect
      .poll(() => app.calls('agent-hub:set-model').then((calls) => calls.at(-1)))
      .toMatchObject({ model: 'shared', provider: 'beta' })
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

  it.each(['light', 'dark'] as const)('clears a saved Worker workflow back to the service default (%s)', async (theme) => {
    const page = await app.open({ scenario: 'workerHost', route: '/settings/devices', theme })
    await page.getByRole('button', { name: 'GPU Worker 更多操作' }).click()
    await page.getByRole('menuitem', { name: '编辑' }).click()
    const dialog = page.getByRole('dialog', { name: '编辑 SSH 主机' })
    await dialog.waitFor()
    expect(await dialog.getByRole('group', { name: '运行方式' }).count()).toBe(1)
    expect(await dialog.getByLabel('服务信息文件').inputValue()).toBe('/srv/worker/discovery.json')
    const workflow = dialog.getByLabel('工作流')
    expect(await workflow.inputValue()).toBe('explicit-wf')
    await workflow.fill('')
    expect(await workflow.getAttribute('placeholder')).toBe('留空自动使用远端服务默认')
    await dialog.getByRole('button', { name: '保存并测试' }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'GPU Worker 更多操作' }).click()
    await page.getByRole('menuitem', { name: '编辑' }).click()
    expect(await workflow.inputValue()).toBe('')
  })

  it('offers only negotiated Worker sampling and lets a saved canvas clear its other choices', async () => {
    const page = await app.open({ scenario: 'workerHost', route: '/studio', defer: true })
    await seedLoraBoard(page, { workerHost: true })
    await page.evaluate(() => {
      window.__mock.state.projects[0]!.canvases[0]!.sampling = { sampler: 'euler', shift: 4, stepCache: 'off', cfgTruncation: 0 }
    })
    await app.start()
    await page
      .getByRole('button', { name: /高级设置/ })
      .first()
      .click()
    const clear = page.getByRole('button', { name: '清除不支持的采样设置' })
    await clear.waitFor()
    for (const field of ['Shift', 'CFG 截断', '步缓存', '高清修复']) expect(await page.getByLabel(field, { exact: true }).count()).toBe(0)
    const generate = page.locator('[data-studio-generate]')
    expect(await generate.isDisabled()).toBe(true)
    expect(await app.calls('http:POST /api/engine-jobs')).toEqual([])
    await clear.click()
    const sampler = page.getByRole('combobox', { name: '采样器' })
    expect(await sampler.inputValue()).toBe('euler')
    await page.getByRole('combobox', { name: '调度器' }).selectOption('karras')
    await generate.click()
    await expect
      .poll(() => app.calls('http:POST /api/engine-jobs'))
      .toMatchObject([{ hostId: 'worker-1', sampling: { sampler: 'euler', scheduler: 'karras' } }])
  })

  it('the LoRA picker lists the Worker’s own LoRA when it is the 运行位置', async () => {
    const page = await openStudio(app, 'workerHost')
    await openLoraRows(page)
    await page.locator('[data-adapter-picker]').first().click()
    const dialog = page.getByRole('dialog', { name: '选择 LoRA · GPU Worker' })
    await dialog.waitFor()
    await expect.poll(() => dialog.getByText('ink.safetensors').first().isVisible()).toBe(true)
  })

  it('the model picker lists the Worker’s detected models when it is the 运行位置', async () => {
    const page = await openStudio(app, 'workerHost')
    await openLoraRows(page)
    const picker = page.locator('[data-model-picker]').first()
    await picker.waitFor()
    await expect.poll(() => picker.textContent()).toContain('MOSS-Image SFT')
    await picker.click()
    await expect.poll(() => page.getByRole('menuitem', { name: /MOSS-Image SFT INT8/ }).isVisible()).toBe(true)
    // The Worker's own id (sft-int8) goes to the job; the 画面 keeps the library's.
    await page.getByRole('menuitem', { name: /MOSS-Image SFT INT8/ }).click()
    await page.locator('[data-studio-generate]').click()
    await expect
      .poll(() => app.calls('http:POST /api/engine-jobs'))
      .toMatchObject([{ hostId: 'worker-1', modelBinding: { bundleId: 'sft-int8' } }])
  })

  it('keeps another 画面’s own model on the Worker after a Worker model is picked', async () => {
    const page = await app.open({ scenario: 'workerHost', route: '/studio', defer: true })
    await seedLoraBoard(page, { workerHost: true })
    await page.evaluate(() => {
      const project = window.__mock.state.projects[0]!
      project.canvases[0]!.modelBundleId = 'moss-sft-int8'
      project.canvases.push(window.__mock.fixtures.canvasFixture({ id: 'c2', title: '画面 2', x: 1200, modelBundleId: 'moss-sft-int8' }))
      // The one pick for every host from before picks were kept per host: neither used nor kept.
      localStorage.setItem('mossstudio.workerModelId', 'moss-sft')
    })
    await app.start()
    await openLoraRows(page)
    const picker = page.locator('[data-model-picker]').first()
    await expect.poll(() => picker.textContent()).toContain('INT8')
    expect(await page.evaluate(() => localStorage.getItem('mossstudio.workerModelId'))).toBeNull()
    // On 画面 1 the Worker's MOSS-Image SFT stands in for its INT8 model.
    await picker.click()
    await page.locator('[role="menuitem"][title="MOSS-Image SFT"]').click()
    await expect.poll(() => picker.textContent()).not.toContain('INT8')
    // 画面 2 has its own model on the Worker too, and keeps it.
    await page.locator('article[data-canvas-card="c2"] header button').first().click()
    await expect.poll(() => picker.textContent()).toContain('INT8')
    await page.locator('[data-studio-generate]').click()
    await expect
      .poll(() => app.calls('http:POST /api/engine-jobs'))
      .toMatchObject([{ hostId: 'worker-1', modelBinding: { bundleId: 'sft-int8' } }])
  })
})
