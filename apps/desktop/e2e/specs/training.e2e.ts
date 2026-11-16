/**
 * 训练: first use (prepare, or why this computer cannot train), choosing what
 * to teach, the editor with its pictures and 高级, a run's sample grid,
 * choosing a step, trying the LoRA in 创作, and 设置 › 训练.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { useApp } from '../support/app'

const hash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash)

describe('training: first use', () => {
  const app = useApp()

  it('prepares the base model, trainer and environment, and lets pictures be picked meanwhile', async () => {
    const page = await app.open({ scenario: 'trainingNotPrepared', route: '/training', defer: true })
    await page.evaluate(() => {
      window.__mock.state.training.prepareStepMs = 700
    })
    await app.start()
    await expect.poll(() => page.getByRole('heading', { name: '训练你自己的 LoRA' }).isVisible()).toBe(true)
    expect(await page.locator('[data-check-row="gpu"]').textContent()).toContain('NVIDIA GeForce RTX 4070 · 12 GB')
    expect(await page.locator('[data-check-row="model"]').textContent()).toContain('需要下载 · 9.5 GB')
    expect(await page.locator('[data-trainer-credit]').textContent()).toContain('KohakuMoss License 1.0')

    await page.getByRole('button', { name: '准备训练' }).click()
    await expect.poll(() => app.calls('training:prepare')).toEqual([{ hostId: 'local' }])
    await expect.poll(() => page.getByRole('button', { name: '先选图片' }).isVisible()).toBe(true)
    // The base model row follows the real download; the trainer row moves without an amount.
    await expect.poll(() => page.locator('[data-check-row="model"]').textContent()).toContain('下载中 43%')
    expect(await page.locator('[data-check-row="trainer"] [role="progressbar"][data-indeterminate]').count()).toBe(1)

    await page.getByRole('button', { name: '先选图片' }).click()
    await expect.poll(() => page.getByRole('heading', { name: '想教模型什么？' }).isVisible()).toBe(true)
  })

  it('says why this computer cannot train, offers another one, or turns training off', async () => {
    let page = await app.open({ scenario: 'trainingBlocked', route: '/training' })
    await expect.poll(() => page.getByRole('heading', { name: '这台电脑不能训练' }).isVisible()).toBe(true)
    expect(await page.locator('[data-check-row="gpu"]').textContent()).toContain('不能训练')
    expect(await page.getByText('用另一台电脑训练').count()).toBe(0)

    page = await app.open({ scenario: 'trainingBlocked', route: '/training', settings: { remoteHostsEnabled: true }, defer: true })
    await page.evaluate(() => {
      window.__mock.state.hosts = [window.__mock.fixtures.sshHostFixture()]
    })
    await app.start()
    await expect.poll(() => page.getByRole('button', { name: '在这台训练' }).isVisible()).toBe(true)
    await page.getByRole('button', { name: '在这台训练' }).click()
    // The remote computer can train: it has no trainings yet, so it asks what to teach.
    await expect.poll(() => page.getByRole('heading', { name: '想教模型什么？' }).isVisible()).toBe(true)

    page = await app.open({ scenario: 'trainingBlocked', route: '/training' })
    await page.evaluate(() => localStorage.removeItem('mossstudio:training-host'))
    await page.getByRole('button', { name: '关闭训练功能' }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ trainingEnabled: false })
    await expect.poll(() => hash(page)).toBe('#/studio')
  })
})

describe('training: a new training', () => {
  const app = useApp()

  it('starts from a tile, takes pictures and shows their problems as chips', async () => {
    const page = await app.open({ scenario: 'ready', route: '/training', settings: { trainingEnabled: true } })
    await page.evaluate(() => localStorage.removeItem('mossstudio:training-host'))
    await page.locator('[data-start-kind="person"]').click()
    await expect.poll(() => app.calls('training:create')).toEqual([{ kind: 'person', hostId: 'local' }])
    await expect.poll(() => hash(page)).toBe('#/training/tp-new-1')
    await expect.poll(() => page.getByRole('button', { name: '开始训练' }).isVisible()).toBe(true)
    expect(await page.locator('[data-length-label]').textContent()).toBe('3,000 步')

    await page.evaluate(() =>
      window.__mock.handle(window.__mock.Ipc.pickImages, () => ['/photos/cat-384x288.png', '/photos/cat-1024x1024.png']),
    )
    await page.getByRole('button', { name: '添加图片' }).click()
    await page.getByRole('menuitem', { name: '选择图片…' }).click()
    await expect.poll(() => page.locator('[data-picture]').count()).toBe(2)
    await expect.poll(() => page.locator('[data-chip="small"]').textContent()).toBe('1 张太小')
    expect(await page.locator('[data-chip="noCaption"]').textContent()).toBe('2 张没有描述')
    await page.locator('[data-chip="small"]').click()
    await expect.poll(() => page.locator('[data-picture]').count()).toBe(1)
    expect(await page.locator('[data-picture]').getAttribute('data-picture')).toBe('cat-384x288.png')

    // 学什么 changes the recipe and keeps the pictures.
    await page.getByRole('group', { name: '学什么' }).getByRole('button', { name: '画风' }).click()
    await expect.poll(() => page.locator('[data-length-label]').textContent()).toBe('1,500 步')
    expect(await page.locator('[data-picture]').count()).toBe(1)
    await expect
      .poll(() =>
        app.calls<{ patch: { kind?: string } }>('training:update').then((calls) => calls.some((call) => call.patch.kind === 'style')),
      )
      .toBe(true)
  })

  it('shows 高级, marks a changed knob 自定义, and stays open the next time', async () => {
    let page = await app.open({ scenario: 'trainings', route: '/training/tp-aming' })
    await page.evaluate(() => localStorage.removeItem('mossstudio.training.advancedOpen'))
    page = await app.open({ scenario: 'trainings', route: '/training/tp-aming' })
    const advanced = page.getByRole('button', { name: /^高级/ })
    await expect.poll(() => advanced.getAttribute('aria-expanded')).toBe('false')
    expect(await advanced.textContent()).toContain('LoKr · 3,000 步 · 本机')
    await advanced.click()
    await expect.poll(() => page.locator('[data-recipe-fields]').isVisible()).toBe(true)
    await page.getByLabel('步数').fill('3500')
    await page.getByLabel('步数').press('Enter')
    await expect.poll(() => page.locator('[data-length-label]').textContent()).toBe('自定义 · 3,500 步')
    await expect
      .poll(() => app.calls<{ patch: { length?: string } }>('training:update').then((calls) => calls.at(-1)?.patch.length))
      .toBe('custom')

    page = await app.open({ scenario: 'trainings', route: '/training/tp-aming' })
    await expect.poll(() => page.getByRole('button', { name: /^高级/ }).getAttribute('aria-expanded')).toBe('true')
    await expect.poll(() => page.locator('[data-recipe-fields]').isVisible()).toBe(true)
  })

  it('explains at the moment 自动写描述 cannot run, and where to fix it', async () => {
    const page = await app.open({ scenario: 'trainings', route: '/training/tp-aming', defer: true })
    await page.evaluate(() => {
      window.__mock.state.training.captionError = '还没有能看图的语言模型'
    })
    await app.start()
    await page.getByRole('button', { name: '自动写描述' }).click()
    await expect.poll(() => page.locator('[data-caption-problem]').textContent()).toContain('还没有能看图的语言模型')
    await expect.poll(() => page.getByRole('button', { name: '连接语言模型' }).isVisible()).toBe(true)
  })

  it('shows why 开始训练 was refused next to the button', async () => {
    const page = await app.open({ scenario: 'trainings', route: '/training/tp-aming', defer: true })
    await page.evaluate(() => {
      window.__mock.state.training.startError = '显卡正在被另一个任务使用'
    })
    await app.start()
    await page.getByRole('button', { name: '开始训练' }).click()
    await expect.poll(() => page.locator('[data-start-problem]').textContent()).toContain('显卡正在被另一个任务使用')
  })
})

describe('training: runs and results', () => {
  const app = useApp()

  it('lists the trainings with the running one on top', async () => {
    const page = await app.open({ scenario: 'trainings', route: '/training' })
    await expect.poll(() => page.locator('[data-training-card]').count()).toBe(6)
    expect(await page.locator('[data-training-card]').first().getAttribute('data-training-card')).toBe('tp-juzi')
    expect(await page.locator('[data-training-card="tp-juzi"]').textContent()).toContain('1,250 / 3,000 步 · 还要约 24 分钟')
    expect(await page.locator('[data-training-card="tp-film"]').textContent()).toContain('显存不够')
    await page.locator('[data-training-card="tp-watercolor"]').click()
    await expect.poll(() => hash(page)).toBe('#/training/tp-watercolor')
  })

  it('starts a draft and follows it as sample columns', async () => {
    const page = await app.open({ scenario: 'trainings', route: '/training/tp-aming' })
    await page.getByRole('button', { name: '开始训练' }).click()
    await expect.poll(() => page.locator('[data-training-view="running"]').isVisible()).toBe(true)
    await expect.poll(() => page.locator('[data-sample-column="0"]').textContent()).toBe('训练前')
    expect(await page.locator('[data-sample-row]').count()).toBe(3)
    expect(await page.locator('[data-sample-pending]').count()).toBeGreaterThan(0)
  })

  it('shows a running training with its progress, loss and log', async () => {
    const page = await app.open({ scenario: 'trainings', route: '/training/tp-juzi' })
    await expect.poll(() => page.locator('[data-run-progress]').textContent()).toBe('1,250 / 3,000 步还要约 24 分钟')
    expect(await page.locator('[data-sample-column]').count()).toBe(13)
    await page.getByRole('button', { name: '查看日志' }).click()
    await expect.poll(() => page.getByRole('complementary', { name: '活动' }).isVisible()).toBe(true)
  })

  it('saves the step whose column is chosen', async () => {
    const page = await app.open({ scenario: 'trainings', route: '/training/tp-watercolor' })
    await expect.poll(() => page.locator('[data-chosen-step]').textContent()).toContain('用 第 1,250 步 的结果')
    expect(await page.locator('[data-sample-column="1250"]').textContent()).toBe('1,250 步 · 已选')
    await page.locator('[data-sample-column="1500"]').click()
    await expect.poll(() => app.calls('training:choose-step')).toEqual([{ id: 'tp-watercolor', step: 1500 }])
    await expect.poll(() => page.locator('[data-chosen-step]').textContent()).toContain('第 1,500 步')
    expect(await page.locator('[data-sample-column="1500"]').getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByText('已保存到 模型 › LoRA').isVisible()).toBe(true)
  })

  it('offers 重试 when the chosen step could not be saved', async () => {
    const page = await app.open({ scenario: 'trainings', route: '/training/tp-watercolor', defer: true })
    await page.evaluate(() => {
      window.__mock.state.training.saveError = '模型文件夹满了，腾出空间后重试'
    })
    await app.start()
    await page.locator('[data-sample-column="1000"]').click()
    await expect.poll(() => page.getByText('模型文件夹满了，腾出空间后重试').isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: '在创作中试用' }).count()).toBe(0)
    await page.evaluate(() => {
      window.__mock.state.training.saveError = null
    })
    await page.getByRole('button', { name: '重试' }).click()
    await expect.poll(() => app.calls('training:choose-step').then((calls) => calls.at(-1))).toEqual({ id: 'tp-watercolor', step: 1000 })
    await expect.poll(() => page.getByRole('button', { name: '在创作中试用' }).isVisible()).toBe(true)
  })

  it('tries the LoRA in 创作 as a 风格 wired into a new 画面', async () => {
    const page = await app.open({ scenario: 'trainings', route: '/training/tp-watercolor' })
    await page.getByRole('button', { name: '在创作中试用' }).click()
    await expect.poll(() => hash(page)).toBe('#/studio')
    const style = page.locator('article[data-canvas-kind="style"]')
    await expect.poll(() => style.count()).toBe(1)
    expect(await style.textContent()).toContain('水彩小镇')
    await expect.poll(() => page.getByLabel('描述').first().inputValue()).toBe('一座海边小镇，清晨')
  })

  it('deletes a training after asking, and says the LoRA stays', async () => {
    const page = await app.open({ scenario: 'trainings', route: '/training/tp-green-mug' })
    await page.getByRole('button', { name: '删除' }).click()
    const dialog = page.getByRole('dialog', { name: '删除「绿色马克杯」？' })
    expect(await dialog.textContent()).toContain('已保存的 LoRA 留在 模型 里')
    await dialog.getByRole('button', { name: '删除' }).click()
    await expect.poll(() => app.calls('training:remove')).toEqual([{ id: 'tp-green-mug' }])
    await expect.poll(() => hash(page)).toBe('#/training')
    await expect.poll(() => page.locator('[data-training-card]').count()).toBe(5)
  })
})

describe('settings › 训练', () => {
  const app = useApp()

  it('holds the trainer, its folder and sources, the remote computers and the credit', async () => {
    let page = await app.open({ scenario: 'ready', route: '/settings/features' })
    expect(await page.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '训练' }).count()).toBe(0)

    page = await app.open({
      scenario: 'remoteHost',
      route: '/settings/training',
      settings: { trainingEnabled: true, remoteHostsEnabled: true },
    })
    await expect.poll(() => page.getByRole('heading', { name: '训练', exact: true }).isVisible()).toBe(true)
    for (const row of ['版本', '更新到', '环境', '训练器文件夹', 'PyTorch 下载源', 'pip 下载源']) {
      expect(await page.getByText(row, { exact: true }).first().isVisible(), row).toBe(true)
    }
    expect(await page.getByRole('heading', { name: '远程电脑' }).isVisible()).toBe(true)
    expect(await page.locator('[data-trainer-credit]').textContent()).toBe('Kohaku Trainer · KohakuMoss License 1.0 · 上游仓库')
    await page.getByRole('button', { name: '上游仓库' }).click()
    await expect.poll(() => app.calls('app:open-external')).toEqual([{ url: 'https://github.com/KohakuBlueleaf/KohakuMossTrainer' }])
  })
})
