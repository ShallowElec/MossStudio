/**
 * 设置: every section by URL, changes save without a Save button, the theme
 * switch, and 功能 toggles that add or remove whole areas of the app.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { useApp } from '../support/app'

const SECTIONS = [
  ['general', '通用'],
  ['devices', '设备与引擎'],
  ['storage', '存储'],
  ['network', '网络'],
  ['llm', '语言模型'],
  ['features', '功能'],
  ['updates', '通知与更新'],
  ['about', '关于'],
] as const

const hash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash)
const theme = (page: Page): Promise<string | undefined> => page.evaluate(() => document.documentElement.dataset.theme)

describe('settings', () => {
  const app = useApp()

  it('opens every section from its URL, and old section names land on the new ones', async () => {
    for (const [id, label] of SECTIONS) {
      const page = await app.open({ route: `/settings/${id}` })
      await expect.poll(() => page.getByRole('heading', { level: 1, name: label }).isVisible()).toBe(true)
      const current = page.getByRole('navigation', { name: '设置分区' }).locator('[aria-current="page"]')
      expect(await current.textContent()).toBe(label)
      expect(await page.getByRole('button', { name: /^保存$/ }).count()).toBe(0)
    }
    for (const [alias, target] of [
      ['/settings', '/settings/general'],
      ['/settings/engines', '/settings/devices'],
      ['/settings/lan', '/settings/features'],
    ] as const) {
      const page = await app.open({ route: alias })
      await expect.poll(() => hash(page)).toBe(`#${target}`)
    }
  })

  it('switches theme immediately and saves it', async () => {
    const page = await app.open({ route: '/settings/general', theme: 'light' })
    expect(await theme(page)).toBe('light')
    const picker = page.getByRole('group', { name: '主题' })
    await picker.getByRole('button', { name: '深色' }).click()
    await expect.poll(() => theme(page)).toBe('dark')
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ theme: 'dark' })
    await picker.getByRole('button', { name: '浅色' }).click()
    await expect.poll(() => theme(page)).toBe('light')

    // 跟随系统 follows the OS preference.
    await page.emulateMedia({ colorScheme: 'dark' })
    await picker.getByRole('button', { name: '跟随系统' }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ theme: 'system' })
    await expect.poll(() => theme(page)).toBe('dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => theme(page)).toBe('light')
    await page.emulateMedia({ colorScheme: null })
  })

  it('offers 界面大小, 自动 by default, and saves a fixed size', async () => {
    const page = await app.open({ route: '/settings/general' })
    const picker = page.getByRole('group', { name: '界面大小' })
    expect(await picker.getByRole('button', { name: '自动' }).getAttribute('aria-pressed')).toBe('true')
    await picker.getByRole('button', { name: '125%' }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ uiScale: '125' })
    await expect.poll(() => picker.getByRole('button', { name: '125%' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('turning 训练 on adds it to the rail; off removes it', async () => {
    const page = await app.open({ route: '/settings/features' })
    const rail = page.getByRole('navigation', { name: '主导航' })
    expect(await rail.getByRole('button', { name: '训练' }).count()).toBe(0)
    await page.getByRole('switch', { name: '训练' }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ trainingEnabled: true })
    await expect.poll(() => rail.getByRole('button', { name: '训练' }).isVisible()).toBe(true)
    await rail.getByRole('button', { name: '训练' }).click()
    await expect.poll(() => hash(page)).toBe('#/training')

    await page.evaluate(() => {
      window.location.hash = '#/settings/features'
    })
    await page.getByRole('switch', { name: '训练' }).click()
    await expect.poll(() => rail.getByRole('button', { name: '训练' }).count()).toBe(0)
    // Its route is gone too: an old link falls back to 创作.
    await page.evaluate(() => {
      window.location.hash = '#/training'
    })
    await expect.poll(() => page.locator('[data-page="/studio"]:not(.hidden)').count()).toBe(1)
  })

  it('turning 远程主机 on shows remote machines in 设备与引擎 and the 模型 location switcher', async () => {
    const page = await app.open({ scenario: 'remoteHost', route: '/settings/devices' })
    await expect.poll(() => page.getByText('未开启').isVisible()).toBe(true)
    expect(await page.getByText('Linux GPU').count()).toBe(0)
    await page.getByRole('button', { name: '在功能中开启' }).click()
    await expect.poll(() => hash(page)).toBe('#/settings/features')

    await page.getByRole('switch', { name: '远程主机', exact: true }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ remoteHostsEnabled: true })
    await page.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '设备与引擎' }).click()
    await expect.poll(() => page.getByText('Linux GPU').first().isVisible()).toBe(true)
    await expect.poll(() => page.getByRole('button', { name: /添加 SSH 主机/ }).isVisible()).toBe(true)

    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '模型' }).click()
    await expect.poll(() => page.getByRole('group', { name: '模型所在的电脑' }).isVisible()).toBe(true)

    // Off again: every trace disappears.
    await page.evaluate(() => {
      window.location.hash = '#/settings/features'
    })
    await page.getByRole('switch', { name: '远程主机', exact: true }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ remoteHostsEnabled: false })
    await page.evaluate(() => {
      window.location.hash = '#/models'
    })
    await expect.poll(() => page.getByRole('group', { name: '模型所在的电脑' }).count()).toBe(0)
    await page.evaluate(() => {
      window.location.hash = '#/settings/devices'
    })
    await expect.poll(() => page.getByText('Linux GPU').count()).toBe(0)
  })

  it('a pasted or typed ssh login command fills 地址, 端口 and 用户名', async () => {
    const page = await app.open({ scenario: 'remoteHost', route: '/settings/devices', defer: true })
    await page.evaluate(() => {
      window.__mock.state.settings = { ...window.__mock.state.settings, remoteHostsEnabled: true }
    })
    await app.start()
    await page.getByRole('button', { name: /添加 SSH 主机/ }).click()
    const dialog = page.getByRole('dialog', { name: '添加 SSH 主机' })
    const address = dialog.getByLabel('地址', { exact: true })
    const port = dialog.getByLabel('端口', { exact: true })
    const user = dialog.getByLabel('用户名', { exact: true })
    await address.focus()
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.setData('text/plain', 'ssh -p 41234 root@connect.example.test')
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await expect.poll(() => address.inputValue()).toBe('connect.example.test')
    expect(await port.inputValue()).toBe('41234')
    expect(await user.inputValue()).toBe('root')

    // Typed whole, it is split when the field is left; a plain address stays as typed.
    await address.fill('ssh -p 2200 moss@gpu.example.test')
    await port.focus()
    await expect.poll(() => address.inputValue()).toBe('gpu.example.test')
    expect(await port.inputValue()).toBe('2200')
    expect(await user.inputValue()).toBe('moss')
    await address.fill('gpu.lan')
    await user.focus()
    expect(await address.inputValue()).toBe('gpu.lan')

    await dialog.getByRole('button', { name: '保存并测试' }).click()
    await expect
      .poll(() => app.calls<{ host?: string }>('hosts:save').then((calls) => calls.at(-1)))
      .toMatchObject({ host: 'gpu.lan', user: 'moss', port: 2200 })
  })

  it('局域网访问 shows its address only when on', async () => {
    const page = await app.open({ route: '/settings/features', theme: 'light' })
    expect(await page.getByRole('heading', { name: '局域网访问' }).count()).toBe(0)
    await page.getByRole('switch', { name: '局域网访问' }).click()
    await expect.poll(() => page.getByText('http://192.168.1.20:7860/?token=fixture').isVisible()).toBe(true)
    await app.screenshot('settings-features-lan-light')
  })

  it('reports a failed save instead of pretending', async () => {
    const page = await app.open({ route: '/settings/general', theme: 'light' })
    await page.evaluate(() => window.__mock.fail('settings:update', { code: 'E_WRITE', message: '设置文件无法写入' }))
    await page.getByRole('group', { name: '主题' }).getByRole('button', { name: '深色' }).click()
    await expect.poll(() => page.getByText(/设置文件无法写入/).isVisible()).toBe(true)
  })
})

describe('设置 › 语言模型', () => {
  const app = useApp()

  /** Ollama (text only), Claude and GPT (both see pictures); GPT is the 助手和漫画 model an older version picked. */
  async function openConnected(theme: 'light' | 'dark' = 'light'): Promise<Page> {
    const page = await app.open({ route: '/settings/llm', defer: true, theme, settings: { languageProviderId: 'gpt' } })
    await page.evaluate(() => {
      const { aiProviderFixture } = window.__mock.fixtures
      window.__mock.state.aiProviders = [
        aiProviderFixture({ id: 'local', kind: 'ollama', name: 'Ollama', model: 'llava' }),
        aiProviderFixture({ id: 'claude', kind: 'anthropic', name: 'Claude', model: 'claude-sonnet' }),
        aiProviderFixture({ id: 'gpt', kind: 'openai', name: 'GPT', model: 'gpt-x' }),
      ]
    })
    await app.start()
    await page.getByRole('heading', { name: '谁来做' }).waitFor()
    return page
  }

  const title = (page: Page, id: string) => page.locator(`[data-provider="${id}"]`)

  it('connects the first model from nothing, and then asks who does what', async () => {
    const page = await app.open({ route: '/settings/llm', theme: 'light' })
    await page.getByText('还没有连接语言模型').waitFor()
    expect(await page.getByRole('heading', { name: '谁来做' }).count()).toBe(0)
    await app.screenshot('settings-llm-empty-light')

    await page.getByRole('button', { name: '连接语言模型' }).click()
    const dialog = page.getByRole('dialog', { name: '连接语言模型' })
    await dialog.getByRole('button', { name: 'DeepSeek' }).click()
    await dialog.getByLabel('API Key').fill('sk-test')
    await dialog.getByRole('button', { name: '添加' }).click()
    await expect.poll(() => dialog.count()).toBe(0)
    expect((await app.calls<{ name: string; apiKey?: string }>('ai:provider-save')).at(-1)).toMatchObject({
      name: 'DeepSeek',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
    })
    await page.getByRole('heading', { name: '谁来做' }).waitFor()
    expect(await page.getByRole('combobox', { name: '助手和漫画' }).locator('option').allTextContents()).toEqual([
      'DeepSeek · deepseek-chat',
    ])
  })

  it('lists each model with what it can do, and keeps the choice an existing user had', async () => {
    const page = await openConnected()
    expect(await title(page, 'claude').textContent()).toBe('Claude能看图')
    expect(await title(page, 'gpt').textContent()).toBe('GPT能看图')
    expect(await title(page, 'local').textContent()).toBe('Ollama')
    expect(await page.getByText('gpt-x', { exact: true }).isVisible()).toBe(true)

    const language = page.getByRole('combobox', { name: '助手和漫画' })
    expect(await language.inputValue()).toBe('gpt')
    expect(await language.locator('option').allTextContents()).toEqual(['Ollama · llava', 'Claude · claude-sonnet', 'GPT · gpt-x'])
    await language.selectOption('local')
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ languageProviderId: 'local' })

    // Only models that can see pictures are offered for 看图; it starts on the first of them.
    const vision = page.getByRole('combobox', { name: '看图' })
    expect(await vision.inputValue()).toBe('claude')
    expect(await vision.locator('option').allTextContents()).toEqual(['Claude · claude-sonnet', 'GPT · gpt-x'])
    await vision.selectOption('gpt')
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ gbcProviderId: 'gpt' })
    await app.screenshot('settings-llm-light')
  })

  it('edits a model without showing or losing its key', async () => {
    const page = await openConnected()
    await page.getByRole('button', { name: '编辑 Claude' }).click()
    const dialog = page.getByRole('dialog', { name: '编辑「Claude」' })
    expect(await dialog.getByLabel('API Key').inputValue()).toBe('')
    await dialog.getByLabel('模型').fill('claude-opus')
    await dialog.getByRole('button', { name: '保存修改' }).click()
    await expect
      .poll(() => app.calls('ai:provider-save').then((calls) => calls.at(-1)))
      .toMatchObject({ id: 'claude', model: 'claude-opus' })
    expect((await app.calls<{ apiKey?: string }>('ai:provider-save')).at(-1)!.apiKey).toBeUndefined()
    await expect.poll(() => page.getByText('claude-opus', { exact: true }).isVisible()).toBe(true)
  })

  it('removes a model only after asking', async () => {
    const page = await openConnected('dark')
    await app.screenshot('settings-llm-dark')
    await page.getByRole('button', { name: '移除 Ollama' }).click()
    const confirm = page.getByRole('dialog', { name: '移除「Ollama」？' })
    await confirm.getByRole('button', { name: '取消' }).click()
    expect(await app.calls('ai:provider-remove')).toEqual([])

    await page.getByRole('button', { name: '移除 Ollama' }).click()
    await confirm.getByRole('button', { name: '移除' }).click()
    await expect.poll(() => app.calls('ai:provider-remove')).toEqual([{ id: 'local' }])
    await expect.poll(() => page.getByRole('button', { name: '编辑 Ollama' }).count()).toBe(0)
  })

  it('offers to connect a model that sees pictures when none does', async () => {
    const page = await app.open({ route: '/settings/llm', defer: true })
    await page.evaluate(() => {
      window.__mock.state.aiProviders = [window.__mock.fixtures.aiProviderFixture({ id: 'local', kind: 'ollama', name: 'Ollama' })]
    })
    await app.start()
    await page.getByRole('button', { name: '连接能看图的模型' }).click()
    const dialog = page.getByRole('dialog', { name: '连接语言模型' })
    // Only the services that can read pictures for 解析 and 拆成区域.
    expect(await dialog.getByLabel('接口类型').locator('option').allTextContents()).toEqual(['OpenAI 兼容', 'Anthropic'])
    expect(await dialog.getByRole('button', { name: 'Ollama (local)' }).count()).toBe(0)
    // Text-only presets are not offered for seeing pictures.
    expect(await dialog.getByRole('button', { name: 'DeepSeek' }).count()).toBe(0)
    expect(await dialog.getByRole('button', { name: 'Moonshot' }).count()).toBe(0)
    expect(await dialog.getByRole('button', { name: 'OpenAI', exact: true }).count()).toBe(1)
  })
})
