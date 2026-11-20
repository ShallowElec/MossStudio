/**
 * First run (/setup) and the readiness line in 创作 while things are missing.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import type { DownloadTask, MossInferDownloadState } from '@shared/types'
import { useApp } from '../support/app'

const hash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash)

describe('first run', () => {
  const app = useApp()

  it('one decision to start, one progress with the time left, the board usable meanwhile, then done on its own', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/studio', theme: 'light' })
    // Nothing works until the computer is prepared, so the app starts here.
    await expect.poll(() => hash(page)).toBe('#/setup')
    await expect.poll(() => page.getByRole('heading', { name: '准备开始创作' }).isVisible()).toBe(true)
    // What it takes, in one line, and where it goes.
    const summary = page.locator('[data-setup-summary]')
    await expect.poll(() => summary.innerText()).toContain('下载约 26 GB')
    expect(await summary.innerText()).toContain('保存到 /fixture/data/models')
    // The GPU is one quiet line; nothing about engines on the way in.
    expect(await page.locator('[data-setup-gpu]').textContent()).toBe('NVIDIA GeForce RTX 4090 · 24 GB')
    expect(await page.getByText(/引擎/).count()).toBe(0)
    await app.screenshot('setup-first-run-light')

    await page.getByRole('button', { name: '开始下载' }).click()
    await expect.poll(() => app.calls('mossinfer:download').then((calls) => calls.length)).toBe(1)
    const bundle = await page.evaluate(() => {
      const recommended = window.__mock.state.catalog.bundles.find((item) => item.recommended)!
      return [...Object.values(recommended.components), recommended.support]
    })
    await expect
      .poll(() => app.calls<{ kind: string; id: string }>('models:download').then((calls) => calls.map((call) => call.id).sort()))
      .toEqual([...bundle].sort())

    // Progress arrives as events from the main process.
    await page.evaluate(() => {
      const { fixtures, Events, state } = window.__mock
      const engine: MossInferDownloadState = fixtures.engineDownloadFixture({
        phase: 'downloading',
        bytes: 360_000_000,
        percent: 40,
        speedBps: 20_000_000,
      })
      window.__mock.emit(Events.mossInferDownload, engine)
      for (const task of state.downloads) {
        window.__mock.emit(Events.download, {
          ...task,
          state: 'running',
          bytes: Math.floor(task.totalBytes / 4),
          speedBps: 30_000_000,
        } satisfies DownloadTask)
      }
    })
    await expect.poll(() => page.getByRole('heading', { name: '正在准备' }).isVisible()).toBe(true)
    // One bar for everything, with the time left in words; the two parts small underneath.
    const progress = page.locator('[data-setup-progress]')
    expect(await progress.getByRole('progressbar').count()).toBe(1)
    await expect.poll(() => progress.innerText()).toMatch(/\d+%[\s\S]*还要约 \d+ 分钟/)
    expect(await progress.getByRole('list', { name: '正在下载' }).getByRole('listitem').allInnerTexts()).toEqual([
      expect.stringContaining('运行组件'),
      expect.stringContaining('MOSS-Image SFT'),
    ])
    await app.screenshot('setup-progress-light')

    // 先去看看 → 创作: the title bar carries the download, 生成 fills up and says why it is off.
    await page.getByRole('button', { name: '先去看看' }).click()
    await expect.poll(() => hash(page)).toBe('#/studio')
    expect((await app.calls<{ onboardingState?: string }>('settings:update')).at(-1)).toEqual({ onboardingState: 'active' })
    const chip = page.locator('[data-preparation-chip]')
    await expect.poll(() => chip.innerText()).toMatch(/准备中 \d+%/)
    const generate = page.locator('[data-studio-generate]')
    await expect.poll(() => generate.innerText()).toMatch(/下载完成后就能生成 · \d+%/)
    expect(await generate.isDisabled()).toBe(true)
    // The download's own reasons step aside: 生成 says it.
    const blockers = page.locator('li').filter({ hasText: /引擎正在安装|还没有可用的模型|还没有下载完/ })
    expect(await blockers.count()).toBe(0)
    // The card's ＋ still gives the reason on its disabled inputs.
    await page.locator('article[data-canvas-card]').first().hover()
    await page.locator('[data-input-adder] button').first().click()
    await expect
      .poll(() => page.getByRole('menuitem', { name: /^起始图/ }).getAttribute('title'))
      .toBe('引擎正在安装 · 40%，就绪后才能把图片接进来')
    await page.keyboard.press('Escape')
    await app.screenshot('studio-preparing-light')
    // The chip goes back to the page that shows the whole preparation.
    await chip.click()
    await expect.poll(() => hash(page)).toBe('#/setup')
    await page.getByRole('button', { name: '先去看看' }).click()
    await expect.poll(() => hash(page)).toBe('#/studio')

    // Everything finishes while the user is away: setup completes and a toast says so.
    await page.evaluate(() => {
      const { fixtures, Events, state } = window.__mock
      state.engineReadiness = fixtures.engineReadyFixture()
      state.engineVersions = [fixtures.engineVersionFixture()]
      window.__mock.emit(Events.mossInferDownload, fixtures.engineDownloadFixture({ phase: 'done', bytes: 900_000_000, percent: 100 }))
      for (const task of [...state.downloads]) window.__mock.playDownload(task)
    })
    await expect.poll(() => chip.count()).toBe(0)
    await expect.poll(() => page.getByText('模型准备好了，可以生成了').isVisible()).toBe(true)
    await expect
      .poll(() => app.calls<{ onboardingState?: string }>('settings:update').then((calls) => calls.at(-1)))
      .toEqual({ onboardingState: 'completed' })
    await expect.poll(() => generate.innerText()).not.toContain('下载完成后')
  })

  it('finishing on 准备 goes straight to the board', async () => {
    const page = await app.open({ scenario: 'engineInstalling', route: '/setup' })
    await expect.poll(() => page.getByRole('heading', { name: '正在准备' }).isVisible()).toBe(true)
    await page.evaluate(() => {
      const { fixtures, Events, state } = window.__mock
      state.engineReadiness = fixtures.engineReadyFixture()
      state.engineVersions = [fixtures.engineVersionFixture()]
      window.__mock.emit(Events.mossInferDownload, fixtures.engineDownloadFixture({ phase: 'done', bytes: 900_000_000, percent: 100 }))
      for (const task of [...state.downloads]) window.__mock.playDownload(task)
    })
    await expect.poll(() => hash(page)).toBe('#/studio')
    expect((await app.calls<{ onboardingState?: string }>('settings:update')).at(-1)).toEqual({ onboardingState: 'completed' })
    await expect.poll(() => page.getByText('模型准备好了，可以生成了').isVisible()).toBe(true)
  })

  it('after a restart mid-install, carries on with the model download by itself', async () => {
    const page = await app.open({ scenario: 'engineInstalling', route: '/setup', theme: 'dark' })
    await expect.poll(() => page.getByRole('heading', { name: '正在准备' }).isVisible()).toBe(true)
    await expect.poll(() => app.calls('models:download').then((calls) => calls.length)).toBeGreaterThan(0)
    // Starting the model must not start a second engine install.
    expect(await app.calls('mossinfer:download')).toHaveLength(0)
    await app.screenshot('setup-installing-dark')
  })

  it('a part that fails while the other keeps going says why, with its own 重试 and 换下载线路', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await app.open({ scenario: 'engineInstalling', route: '/setup', theme })
      await expect.poll(() => page.getByRole('heading', { name: '正在准备' }).isVisible()).toBe(true)
      await expect.poll(() => app.calls('models:download').then((calls) => calls.length)).toBeGreaterThan(0)
      // Nothing of the model has arrived yet: no 未知 for the amount.
      const progress = page.locator('[data-setup-progress]')
      await expect.poll(() => progress.innerText()).toContain('准备中')
      expect(await progress.innerText()).not.toContain('未知')

      await page.evaluate(() => {
        const { fixtures, Events, state } = window.__mock
        for (const task of state.downloads) {
          window.__mock.emit(Events.download, {
            ...task,
            state: 'running',
            bytes: Math.floor(task.totalBytes / 4),
            speedBps: 30_000_000,
          } satisfies DownloadTask)
        }
        window.__mock.emit(
          Events.mossInferDownload,
          fixtures.engineDownloadFixture({ phase: 'error', failedPhase: 'downloading', error: '下载中断：连接被重置' }),
        )
      })
      // The model keeps downloading; the engine says why it stopped, right on the progress screen.
      const failed = page.locator('[data-setup-failed="engine"]')
      await expect.poll(() => failed.innerText()).toContain('运行组件没有下载完')
      expect(await failed.innerText()).toContain('下载中断：连接被重置')
      expect(await page.getByRole('heading', { name: '正在准备' }).isVisible()).toBe(true)
      const parts = progress.getByRole('listitem')
      expect(await parts.filter({ hasText: 'MOSS-Image SFT' }).innerText()).toMatch(/GB \/ .*GB/)
      // The stopped part does not read as fetched.
      expect(await parts.filter({ hasText: '运行组件' }).innerText()).toContain('没下载完')
      await app.screenshot(`setup-part-failed-${theme}`)

      // Elsewhere, the title bar warns while the model still downloads.
      await page.getByRole('button', { name: '先去看看' }).click()
      await expect.poll(() => hash(page)).toBe('#/studio')
      const chip = page.locator('[data-preparation-chip]')
      await expect.poll(() => chip.innerText()).toMatch(/准备中 \d+% · 有一项没下载完/)
      await app.screenshot(`studio-part-failed-${theme}`)
      // Back on 准备 the failure is still there, not retried unseen.
      await chip.click()
      await expect.poll(() => hash(page)).toBe('#/setup')
      await expect.poll(() => failed.isVisible()).toBe(true)
      expect(await app.calls('mossinfer:download')).toHaveLength(0)

      // 换下载线路 opens the download settings.
      await failed.getByRole('button', { name: '换下载线路' }).click()
      await expect.poll(() => hash(page)).toBe('#/settings/network')
      await page.locator('[data-preparation-chip]').click()
      await expect.poll(() => hash(page)).toBe('#/setup')

      // 重试 starts the engine again, and only the engine.
      const modelCalls = (await app.calls('models:download')).length
      await page.locator('[data-setup-failed="engine"]').getByRole('button', { name: '重试' }).click()
      await expect.poll(() => app.calls('mossinfer:download').then((calls) => calls.length)).toBe(1)
      await expect.poll(() => page.locator('[data-setup-failed]').count()).toBe(0)
      expect(await app.calls('models:download')).toHaveLength(modelCalls)
    }
  })

  it('one model file fails while the others keep downloading: its notice, 重试 for that file only, and the bytes keep moving', async () => {
    const page = await app.open({ scenario: 'engineInstalling', route: '/setup', theme: 'light' })
    await expect.poll(() => page.getByRole('heading', { name: '正在准备' }).isVisible()).toBe(true)
    await expect.poll(() => app.calls('models:download').then((calls) => calls.length)).toBeGreaterThan(0)
    // The VAE gets HTTP 502; the DiT and the rest are still downloading.
    const failedId = await page.evaluate(() => {
      const { Events, state } = window.__mock
      const tasks = state.downloads
      const failed = tasks.find((task) => task.targetId.includes('vae')) ?? tasks.at(-1)!
      for (const task of tasks) {
        window.__mock.emit(
          Events.download,
          task === failed
            ? ({ ...task, state: 'error', error: 'HTTP 502', speedBps: 0 } satisfies DownloadTask)
            : ({ ...task, state: 'running', bytes: Math.floor(task.totalBytes / 4), speedBps: 30_000_000 } satisfies DownloadTask),
        )
      }
      return failed.targetId
    })
    const failed = page.locator('[data-setup-failed="model"]')
    await expect.poll(() => failed.innerText()).toContain('MOSS-Image SFT 没有下载完')
    expect(await failed.innerText()).toContain('HTTP 502')
    expect(await failed.getByRole('button', { name: '换下载线路' }).isVisible()).toBe(true)
    // The model row keeps its bytes and speed while its other files download.
    const row = page.locator('[data-setup-progress]').getByRole('listitem').filter({ hasText: 'MOSS-Image SFT' })
    expect(await row.innerText()).toMatch(/GB \/ .*GB · .*\/s/)
    expect(await row.innerText()).not.toContain('没下载完')
    await app.screenshot('setup-model-file-failed-light')

    // 重试 asks again for the failed file only; the ones still downloading are left alone.
    const before = (await app.calls<{ id: string }>('models:download')).length
    await failed.getByRole('button', { name: '重试' }).click()
    await expect
      .poll(() => app.calls<{ id: string }>('models:download').then((calls) => calls.slice(before).map((call) => call.id)))
      .toEqual([failedId])
  })

  it('an engine that fails after its download says it was not installed, without 换下载线路', async () => {
    const page = await app.open({ scenario: 'engineInstalling', route: '/setup', theme: 'dark' })
    await expect.poll(() => page.getByRole('heading', { name: '正在准备' }).isVisible()).toBe(true)
    await expect.poll(() => app.calls('models:download').then((calls) => calls.length)).toBeGreaterThan(0)
    await page.evaluate(() => {
      const { fixtures, Events } = window.__mock
      window.__mock.emit(
        Events.mossInferDownload,
        fixtures.engineDownloadFixture({ phase: 'error', failedPhase: 'verifying', error: '引擎包 sha256 校验失败（SHA256SUMS 不匹配）' }),
      )
    })
    const failed = page.locator('[data-setup-failed="engine"]')
    await expect.poll(() => failed.innerText()).toContain('运行组件没有装好')
    expect(await failed.getByRole('button', { name: '换下载线路' }).count()).toBe(0)
    expect(await failed.getByRole('button', { name: '重试' }).isVisible()).toBe(true)
    await app.screenshot('setup-engine-not-installed-dark')
  })

  it('without a usable GPU: another computer or 重新检测, as two choices', async () => {
    const page = await app.open({ scenario: 'noGpu', route: '/setup', theme: 'dark' })
    await expect.poll(() => page.getByRole('heading', { name: '这台电脑跑不了模型' }).isVisible()).toBe(true)
    // Nothing can start while blocked.
    expect(await page.getByRole('button', { name: '开始下载' }).count()).toBe(0)
    await app.screenshot('setup-no-gpu-dark')

    // The driver gets fixed; 重新检测 finds the GPU and setup can start.
    await page.evaluate(() => {
      const { fixtures, state } = window.__mock
      state.gpuInventory = fixtures.gpuInventoryFixture()
      state.devices = [fixtures.launchDeviceFixture()]
      state.engineMachine = fixtures.machineFixture('nvidia')
    })
    await page.getByRole('button', { name: /重新检测/ }).click()
    await expect.poll(() => app.calls('gpu:inventory-refresh').then((calls) => calls.length)).toBeGreaterThan(0)
    // The machine is probed again too (AMD / Intel GPUs come from there).
    await expect
      .poll(() => app.calls<{ refresh?: boolean }>('engine:plan').then((calls) => calls.filter((call) => call?.refresh).length))
      .toBeGreaterThan(1)
    await expect.poll(() => page.getByRole('button', { name: '开始下载' }).isEnabled()).toBe(true)
    expect(await page.getByRole('heading', { name: '这台电脑跑不了模型' }).count()).toBe(0)
  })

  it('用另一台电脑 turns on remote hosts and adds one right there', async () => {
    const page = await app.open({ scenario: 'noGpu', route: '/setup' })
    await page.getByRole('button', { name: /用另一台电脑/ }).click()
    await expect
      .poll(() => app.calls<{ remoteHostsEnabled?: boolean }>('settings:update').then((calls) => calls.at(-1)))
      .toEqual({ remoteHostsEnabled: true })
    const dialog = page.getByRole('dialog', { name: '添加 SSH 主机' })
    await expect.poll(() => dialog.isVisible()).toBe(true)
    await dialog.getByLabel('地址', { exact: true }).fill('gpu.lan')
    await dialog.getByLabel('用户名', { exact: true }).fill('moss')
    await dialog.getByRole('button', { name: '保存并测试' }).click()
    await expect.poll(() => app.calls('hosts:save').then((calls) => calls.length)).toBe(1)
    // 设备 prepares it from there: connection, engine, then the model.
    await expect.poll(() => hash(page)).toBe('#/settings/devices')
    expect((await app.calls<{ onboardingState?: string }>('settings:update')).at(-1)).toEqual({ onboardingState: 'active' })
  })

  it('已有模型文件… uses a local folder instead of the 25 GB download', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/setup', defer: true })
    await page.evaluate(() => {
      window.__mock.state.localModelFolder = {
        path: '/workspace/Models/MOSS-Image/sft',
        name: 'MOSS-Image SFT（sft）',
        bundleId: 'moss-sft',
      }
    })
    await app.start()
    await page.getByRole('button', { name: '使用已有模型', exact: true }).click()
    await page.getByRole('button', { name: '已有模型文件…' }).click()
    await expect.poll(() => app.calls('models:import-folder').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => page.getByText(/已在原位置使用 MOSS-Image SFT（sft），不用再下载模型/).isVisible()).toBe(true)
    // The quiet action leaves once the model is there, and only the runtime is left to download.
    await expect.poll(() => page.getByRole('button', { name: '已有模型文件…' }).count()).toBe(0)
    await expect.poll(() => page.locator('[data-setup-summary]').innerText()).toMatch(/下载约 \d+ MB/)
    await page.getByRole('button', { name: '开始下载' }).click()
    await expect.poll(() => app.calls('mossinfer:download').then((calls) => calls.length)).toBe(1)
    expect(await app.calls('models:download')).toEqual([])
  })

  it('a folder that is not a usable MOSS-Image keeps the download, and says why', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/setup', defer: true })
    await page.evaluate(() => {
      window.__mock.state.localModelFolder = { path: '/data/my-finetune', name: 'my-finetune', bundleId: 'none' }
    })
    await app.start()
    await page.getByRole('button', { name: '使用已有模型', exact: true }).click()
    await page.getByRole('button', { name: '已有模型文件…' }).click()
    await expect.poll(() => page.getByText(/不是可以直接使用的 MOSS-Image 模型/).isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: '已有模型文件…' }).count()).toBe(1)
  })

  it('keeps setup in reuse mode when the engine is being prepared before choosing weights', async () => {
    const page = await app.open({ scenario: 'engineInstalling', route: '/setup', settings: { onboardingReusePending: true } })
    await expect.poll(() => page.getByRole('heading', { name: '正在准备' }).isVisible()).toBe(true)
    expect(await app.calls('models:download')).toEqual([])
  })

  it('uses the shared combination and requests only its missing runtime files', async () => {
    const page = await app.open({ scenario: 'sharedModelDirectory', route: '/setup', theme: 'light' })
    await page.getByRole('button', { name: '使用已有模型', exact: true }).click()
    await page.getByRole('button', { name: '接入', exact: true }).click()
    await page.getByRole('button', { name: '自己组合', exact: true }).click()
    expect(await page.locator('#combination-dit').inputValue()).toBe('shared-dit')
    expect(await page.locator('#combination-textEncoder').inputValue()).toBe('shared-text_encoder')
    expect(await page.locator('#combination-vae').inputValue()).toBe('shared-vae')
    await app.screenshot('setup-shared-models-light')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__mock.state.settings.onboardingModelId)).toBeTruthy()
    expect(await app.calls('models:download')).toEqual([])
    await page.getByRole('button', { name: '开始下载' }).click()
    await expect.poll(() => app.calls('models:download')).toEqual([{ kind: 'model', id: 'moss-runtime-config' }])
  })

  it('稍后 leaves setup and never comes back on its own', async () => {
    const page = await app.open({ scenario: 'firstRun', route: '/setup' })
    await page.getByRole('button', { name: '稍后' }).click()
    await expect.poll(() => hash(page)).toBe('#/studio')
    expect((await app.calls<{ onboardingState?: string }>('settings:update')).at(-1)).toEqual({ onboardingState: 'dismissed' })
    await expect.poll(() => page.getByText('引擎未就绪', { exact: true }).isVisible()).toBe(true)
    // The readiness line's action goes where the engine is managed now that setup was dismissed.
    await page.locator('li', { hasText: '引擎未就绪' }).getByRole('button', { name: '去设置' }).click()
    await expect.poll(() => hash(page)).toBe('#/settings/devices')
  })
})

/** The recommended model's four parts (25.3 GiB) plus one margin, (25.3 + 1) × 1.1 ≈ 29 GB, against 12 GB free. */
const LOW_DISK_LINE = '这个位置只剩 12 GB，换一个有 29 GB 空闲的位置。'

describe('first run on a computer that cannot run it, or runs it slowly', () => {
  const app = useApp()
  const reason = (page: Page) => page.locator('[data-setup-reason]').textContent()
  const need = '需要 NVIDIA RTX 30 及更新的显卡，或支持 Vulkan 1.2 的显卡。哪些电脑能用'

  /** The ways forward stay the same whatever the reason; nothing can start. */
  async function expectWaysForward(page: Page): Promise<void> {
    expect(await page.getByRole('button', { name: /用另一台电脑/ }).count()).toBe(1)
    expect(await page.getByRole('button', { name: /重新检测/ }).count()).toBe(1)
    expect(await page.getByRole('button', { name: '先随便看看' }).count()).toBe(1)
    expect(await page.getByRole('button', { name: '开始下载' }).count()).toBe(0)
  }

  it('a GPU the engine cannot use: names the card and why, says what is needed, links to which computers work', async () => {
    const page = await app.open({ scenario: 'machineUnusableGpu', route: '/setup', theme: 'light' })
    await expect.poll(() => page.getByRole('heading', { name: '这台电脑跑不了模型' }).isVisible()).toBe(true)
    await expect.poll(() => reason(page)).toBe('Intel(R) UHD Graphics 620 不支持 Vulkan 1.2，引擎没法在它上面运行。')
    expect(await page.locator('[data-setup-need]').textContent()).toBe(need)
    await expectWaysForward(page)
    await app.screenshot('setup-cannot-run-gpu-light')
    await page.getByRole('button', { name: '哪些电脑能用' }).click()
    await expect.poll(() => app.calls('app:open-external')).toEqual([{ url: 'https://github.com/ShallowElec/MossStudio#哪些电脑能用' }])
  })

  it('a GPU with 2 GB: blocked, with how much it has and how much it needs', async () => {
    const page = await app.open({ scenario: 'machineTinyGpu', route: '/setup', theme: 'dark' })
    await expect.poll(() => page.getByRole('heading', { name: '这台电脑跑不了模型' }).isVisible()).toBe(true)
    await expect.poll(() => reason(page)).toBe('NVIDIA GeForce GT 1030 只有 2 GB 显存，至少需要 4 GB。')
    // What is needed names memory: the person already has a card.
    expect(await page.locator('[data-setup-need]').textContent()).toBe(
      '需要显存至少 4 GB 的显卡：NVIDIA RTX 30 及更新，或支持 Vulkan 1.2 的显卡。哪些电脑能用',
    )
    await expectWaysForward(page)
    await app.screenshot('setup-cannot-run-memory-dark')
  })

  it('the Mac screen keeps its own sentence, without the GPU line', async () => {
    const page = await app.open({ scenario: 'machineMac', route: '/setup' })
    await expect.poll(() => reason(page)).toBe('需要一台装有 NVIDIA 显卡的电脑。')
    expect(await page.locator('[data-setup-need]').count()).toBe(0)
  })

  it('兼容模式: the tick turns amber and one line says it will be very slow; 开始下载 still works', async () => {
    const page = await app.open({ scenario: 'machineIntel', route: '/setup', theme: 'light' })
    // Vulkan reports no memory size for a non-NVIDIA card.
    await expect.poll(() => page.locator('[data-setup-gpu]').textContent()).toBe('Intel(R) Arc(TM) A770 Graphics · 显存未知 · 兼容模式')
    expect(await page.locator('[data-setup-slow]').textContent()).toBe('能用，但会很慢：一张图可能要几分钟甚至更久。')
    expect(await page.getByRole('button', { name: '详情' }).count()).toBe(1)
    await expect.poll(() => page.getByRole('button', { name: '开始下载' }).isEnabled()).toBe(true)
    await app.screenshot('setup-slow-light')
  })

  it('a laptop whose 2 GB card is too small runs on its integrated GPU: not blocked, slow', async () => {
    const page = await app.open({ scenario: 'machineLaptopSmallGpu', route: '/setup' })
    await expect
      .poll(() => page.locator('[data-setup-gpu]').textContent())
      .toBe('Intel(R) UHD Graphics 620 · 显存未知 · 兼容模式 · 共 2 块')
    expect(await page.locator('[data-setup-slow]').textContent()).toBe('能用，但会很慢：一张图可能要几分钟甚至更久。')
    expect(await page.getByRole('heading', { name: '这台电脑跑不了模型' }).count()).toBe(0)
    await expect.poll(() => page.getByRole('button', { name: '开始下载' }).isEnabled()).toBe(true)
  })

  it('a 6 GB card, or 8 GB of memory: one line with the number', async () => {
    let page = await app.open({ scenario: 'machineSmallGpu', route: '/setup' })
    await expect.poll(() => page.locator('[data-setup-slow]').textContent()).toBe('显存 6 GB，能用，生成会慢一些。')
    page = await app.open({ scenario: 'lowMemory', route: '/setup' })
    await expect.poll(() => page.locator('[data-setup-slow]').textContent()).toBe('内存 8 GB，能用，生成会慢一些。')
    await expect.poll(() => page.getByRole('button', { name: '开始下载' }).isEnabled()).toBe(true)
    // A computer with room to spare has no such line.
    page = await app.open({ scenario: 'firstRun', route: '/setup' })
    await expect.poll(() => page.locator('[data-setup-gpu]').textContent()).toBe('NVIDIA GeForce RTX 4090 · 24 GB')
    expect(await page.locator('[data-setup-slow]').count()).toBe(0)
  })

  it('too little room in the folder: says so before the download, and 更改 to a bigger one lets it start', async () => {
    const page = await app.open({ scenario: 'lowDisk', route: '/setup', theme: 'dark' })
    const summary = page.locator('[data-setup-summary]')
    await expect.poll(() => summary.innerText()).toContain('下载约 26 GB')
    const line = page.locator('[data-setup-disk]')
    await expect.poll(() => line.textContent()).toBe(LOW_DISK_LINE)
    expect(await line.getAttribute('role')).toBe('status')
    expect(await page.getByRole('button', { name: '开始下载' }).isDisabled()).toBe(true)
    await app.screenshot('setup-low-disk-dark')

    // Space freed in the file manager: coming back to the window reads it again.
    await page.evaluate(() => {
      window.__mock.state.diskFree = { '/fixture/data/models': 13 * 1024 ** 3 }
      window.dispatchEvent(new Event('focus'))
    })
    await expect.poll(() => line.textContent()).toBe(LOW_DISK_LINE.replace('只剩 12 GB', '只剩 13 GB'))

    await page.evaluate(() => window.__mock.handle(window.__mock.Ipc.pickDialog, () => '/mnt/big/models'))
    await summary.getByRole('button', { name: '更改' }).click()
    await expect.poll(() => summary.innerText()).toContain('保存到 /mnt/big/models')
    await expect.poll(() => page.locator('[data-setup-disk]').count()).toBe(0)
    await expect.poll(() => page.getByRole('button', { name: '开始下载' }).isEnabled()).toBe(true)
  })
})

describe('readiness in 创作', () => {
  const app = useApp()

  it('says what is missing with a link to 模型, and nothing else in the way', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/studio' })
    await page.locator('[data-project-switcher]').waitFor()
    await expect.poll(() => page.locator('li').filter({ hasText: '还没有可用的模型' }).count()).toBe(1)
    expect(await page.locator('[data-studio-generate]').isDisabled()).toBe(true)
    await page.getByRole('button', { name: '去下载' }).click()
    await expect.poll(() => hash(page)).toBe('#/models')
  })

  it('has no placeholder buttons anywhere', async () => {
    const routes = [
      '/studio',
      '/library',
      '/models',
      '/settings/general',
      '/settings/devices',
      '/settings/storage',
      '/settings/network',
      '/settings/features',
      '/settings/training',
      '/settings/updates',
      '/settings/about',
      '/training',
    ]
    for (const route of routes) {
      const page = await app.open({
        scenario: 'ready',
        route,
        settings: { trainingEnabled: true, remoteHostsEnabled: true, lanWebEnabled: true },
      })
      const text = await page.evaluate(() => document.body.innerText)
      for (const stub of ['后续版本', '即将推出', '敬请期待', 'TODO', 'Coming soon', '未实现']) {
        expect(text, `${route} shows "${stub}"`).not.toContain(stub)
      }
    }
  })
})
