/**
 * 导入模型: one entry point (the 模型 page's button, or files dropped on the
 * window or the board), every file recognised by the engine, the parts made
 * into a model, LoRA routed to its list, a reason for what cannot be used,
 * 去创作 with the new model, and a model whose own file moved.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { useApp, type Theme } from '../support/app'
import { expectVisualRules } from '../support/visual'

/** Drags files from outside onto `selector` and, unless `hold`, lets go. Model files get a /drop/<name> path (the mock's bridge). */
async function dragFiles(page: Page, names: string[], { selector = 'main', drop = true } = {}): Promise<void> {
  await page.evaluate(
    ([files, target, letGo]) => {
      const data = new DataTransfer()
      for (const name of files as string[]) data.items.add(new File(['weights'], name, { type: name.endsWith('.txt') ? 'text/plain' : '' }))
      const element = document.querySelector(target as string)!
      const box = element.getBoundingClientRect()
      const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }
      element.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true, ...at }))
      element.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true, ...at }))
      if (letGo) element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, ...at }))
    },
    [names, selector, drop] as const,
  )
}

const sheet = (page: Page) => page.locator('[data-model-import]')

describe('导入模型', () => {
  const app = useApp()

  it('has one 导入模型 button with 选择文件… and 选择文件夹…, and 自己组合 beside 我的模型', async () => {
    for (const theme of ['light', 'dark'] as Theme[]) {
      const page = await app.open({ scenario: 'modelImport', route: '/models', theme })
      await page.getByRole('button', { name: '导入模型' }).click()
      const menu = page.getByRole('menu', { name: '导入模型' })
      await expect.poll(() => menu.getByRole('menuitem').allTextContents()).toEqual(['选择文件…', '选择文件夹…'])
      const mine = page.locator('section').filter({ has: page.getByRole('heading', { name: '我的模型', exact: true }) })
      expect(await mine.getByRole('button', { name: '自己组合' }).isVisible()).toBe(true)
      // The old entry points are gone.
      expect(await page.getByText('用电脑上的模型文件…').count()).toBe(0)
      await page.getByRole('tab', { name: 'LoRA' }).click()
      expect(await page.getByRole('button', { name: '导入 LoRA 文件' }).count()).toBe(0)
      await page.getByRole('tab', { name: '模型', exact: true }).click()
      await page.getByRole('button', { name: '导入模型' }).click()
      await app.screenshot(`model-import-button-${theme}`)
      await page.keyboard.press('Escape')
    }
  })

  it('shows what letting go does while files are dragged over the window, and imports them on drop', async () => {
    for (const theme of ['light', 'dark'] as Theme[]) {
      const page = await app.open({ scenario: 'modelImport', route: '/models', theme })
      await dragFiles(page, ['moss_image_sft_int8_convrot.safetensors', 'ink-style.safetensors'], { drop: false })
      const overlay = page.locator('[data-model-drop]')
      await expect.poll(() => overlay.getByText('松开导入模型、LoRA 或控制适配器').isVisible()).toBe(true)
      expect(await overlay.getByText('2 个文件').isVisible()).toBe(true)
      await expectVisualRules(page, `drop overlay (${theme})`)
      await app.screenshot(`model-import-drop-${theme}`)
      await dragFiles(page, ['moss_image_sft_int8_convrot.safetensors', 'ink-style.safetensors'])
      await expect.poll(() => overlay.count()).toBe(0)
      await expect
        .poll(() => app.calls('models:import'))
        .toEqual([{ paths: ['/drop/moss_image_sft_int8_convrot.safetensors', '/drop/ink-style.safetensors'] }])
      await expect.poll(() => sheet(page).isVisible()).toBe(true)
    }
  })

  it('shows each file while the engine checks it, and keeps going in the background', async () => {
    for (const theme of ['light', 'dark'] as Theme[]) {
      const page = await app.open({ scenario: 'modelImport', route: '/models', theme, defer: true })
      await page.evaluate(() => {
        window.__mock.state.importHold = true
      })
      await app.start()
      await dragFiles(page, ['moss_image_sft_int8_convrot.safetensors', 'ink-style.safetensors', 'sd_xl_base_1.0.safetensors'])
      const dialog = page.getByRole('dialog', { name: '正在识别 3 个文件…' })
      await expect.poll(() => dialog.isVisible()).toBe(true)
      expect(await dialog.getByRole('progressbar', { name: '识别进度' }).isVisible()).toBe(true)
      expect(await dialog.getByText('0 / 3').isVisible()).toBe(true)
      await expectVisualRules(page, `import sheet checking (${theme})`)
      await app.screenshot(`model-import-checking-${theme}`)
      await dialog.getByRole('button', { name: '在后台继续' }).click()
      await expect.poll(() => dialog.count()).toBe(0)
      await page.evaluate(() => window.__mock.finishImport())
      await expect.poll(() => page.getByText('识别完了：3 个文件').isVisible()).toBe(true)
    }
  })

  it('recognises a catalog file by its name and size, and offers its missing parts in one download', async () => {
    const page = await app.open({ scenario: 'modelImport', route: '/models', theme: 'light' })
    await dragFiles(page, ['moss_image_sft_int8_convrot.safetensors'])
    const dialog = page.getByRole('dialog', { name: '识别完了' })
    await expect.poll(() => dialog.getByText('认出来了：MOSS-Image SFT INT8').isVisible()).toBe(true)
    expect(await dialog.getByText('模型的一部分', { exact: true }).isVisible()).toBe(true)
    // The INT8 main model takes the INT8 text encoder and the VAE; the 20 MB runtime config is folded in.
    const download = dialog.getByRole('button', { name: '还缺文本编码器和 VAE · 下载 10 GB' })
    expect(await download.isVisible()).toBe(true)
    await download.click()
    await expect.poll(() => app.calls('models:install-bundle')).toEqual([{ id: 'moss-sft-int8' }])
  })

  it('makes one model of the parts that came together, and 去创作 opens 创作 with it', async () => {
    for (const theme of ['light', 'dark'] as Theme[]) {
      const page = await app.open({ scenario: 'modelImport', route: '/models', theme })
      await dragFiles(page, ['my-finetune.safetensors', 'qwen3.5_int8.safetensors', 'flux2-vae.safetensors', 'ink-style.safetensors'])
      const dialog = page.getByRole('dialog', { name: '可以用了：my-finetune' })
      await expect.poll(() => dialog.isVisible()).toBe(true)
      expect(await dialog.getByText('在原位置使用，不占额外空间').isVisible()).toBe(true)
      // The LoRA went to its own list.
      const lora = dialog.getByText('ink-style.safetensors').locator('xpath=ancestor::*[.//span[text()="LoRA"]][1]')
      expect(await lora.getByText('已加入').isVisible()).toBe(true)
      await expectVisualRules(page, `import sheet done (${theme})`)
      await app.screenshot(`model-import-done-${theme}`)
      expect(await app.calls('models:install-bundle')).toEqual([])
      await dialog.getByRole('button', { name: '去创作' }).click()
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/studio')
      await expect.poll(() => page.evaluate(() => localStorage.getItem('mossstudio.modelBundleId'))).toBe('combo-import-1')
      await page.evaluate(() => localStorage.removeItem('mossstudio.modelBundleId'))
      // The LoRA is listed where LoRA are, used where it is.
      await page.evaluate(() => {
        window.location.hash = '#/models'
      })
      await page.getByRole('tab', { name: 'LoRA' }).click()
      const installed = page.locator('section').filter({ has: page.getByRole('heading', { name: '已安装' }) })
      await expect.poll(() => installed.getByText('ink-style', { exact: true }).isVisible()).toBe(true)
      expect(await installed.getByText('在原位置使用').first().isVisible()).toBe(true)
      expect(await installed.getByRole('button', { name: '移除 ink-style' }).isVisible()).toBe(true)
    }
  })

  it('says in one sentence why a file cannot be used, with the one way out', async () => {
    const page = await app.open({ scenario: 'modelImport', route: '/models', theme: 'dark' })
    await dragFiles(page, ['sd_xl_base_1.0.safetensors', 'moss_image_sft_fp16_fixed.safetensors'])
    const dialog = page.getByRole('dialog', { name: '识别完了' })
    await expect.poll(() => dialog.getByText('sd_xl_base_1.0 不是 MOSS-Image 模型，MossStudio 用不了它。').isVisible()).toBe(true)
    expect(await dialog.getByText('这是 FP16 版本，引擎读不了。换成 INT8 版本就能用。').isVisible()).toBe(true)
    // B3: nothing unusable is ever 可以用了.
    expect(await dialog.getByText(/可以用了/).count()).toBe(0)
    expect(await dialog.getByRole('button', { name: '去创作' }).count()).toBe(0)
    await dialog.getByRole('button', { name: '下载 INT8 版' }).click()
    await expect.poll(() => app.calls('models:install-bundle')).toEqual([{ id: 'moss-sft-int8' }])
  })

  it('sends a model file dropped on the board to 导入模型, and refuses a file the board cannot use (B10)', async () => {
    const page = await app.open({ scenario: 'modelImport', route: '/studio' })
    await page.locator('[data-board]').waitFor()
    await dragFiles(page, ['notes.txt'], { selector: '[data-board]' })
    await expect.poll(() => page.getByText('这里只能放图片或模型文件').isVisible()).toBe(true)
    expect(await app.calls('models:import')).toEqual([])
    // The window's drop layer stays away from the board, which answers file drags itself.
    await dragFiles(page, ['ink-style.safetensors'], { selector: '[data-board]', drop: false })
    expect(await page.locator('[data-model-drop]').count()).toBe(0)
    await dragFiles(page, ['ink-style.safetensors'], { selector: '[data-board]' })
    await expect.poll(() => app.calls('models:import')).toEqual([{ paths: ['/drop/ink-style.safetensors'] }])
    await expect.poll(() => page.getByRole('dialog', { name: '识别完了' }).getByText('LoRA', { exact: true }).isVisible()).toBe(true)
  })
})

describe('a model whose own file moved', () => {
  const app = useApp()

  it('says 找不到文件 with 重新找到… and 移除 instead of a download (B1), and Studio says where it was', async () => {
    for (const theme of ['light', 'dark'] as Theme[]) {
      const page = await app.open({ scenario: 'modelFileMoved', route: '/models', theme })
      const mine = page.locator('section').filter({ has: page.getByRole('heading', { name: '我的模型', exact: true }) })
      const row = mine.getByText('我的 INT8我的组合', { exact: true }).locator('xpath=ancestor::*[.//button][1]')
      await expect.poll(() => row.getByText('找不到文件', { exact: true }).isVisible()).toBe(true)
      expect(
        await row
          .getByText('找不到「moss_image_sft_int8」（E:\\Models\\moss_image_sft_int8.safetensors）。插上那块硬盘，或重新找到它。')
          .isVisible(),
      ).toBe(true)
      expect(await row.getByRole('button', { name: '重新找到…' }).isVisible()).toBe(true)
      expect(await row.getByRole('button', { name: '移除 我的 INT8' }).isVisible()).toBe(true)
      expect(await row.getByRole('button', { name: '下载' }).count()).toBe(0)
      await app.screenshot(`models-file-moved-${theme}`)
    }
    const page = await app.open({ scenario: 'modelFileMoved', route: '/models' })
    const row = page.getByText('我的 INT8我的组合', { exact: true }).locator('xpath=ancestor::*[.//button][1]')
    await row.getByRole('button', { name: '重新找到…' }).click()
    await expect.poll(() => app.calls('models:relocate')).toEqual([{ bundleId: 'combo-moved' }])
    await expect.poll(() => row.getByText('可以使用', { exact: true }).isVisible()).toBe(true)
    expect(await app.calls('models:install-bundle')).toEqual([])
  })

  it('blocks 生成 in Studio with where the file was and the way to find it again', async () => {
    const page = await app.open({ scenario: 'modelFileMoved', route: '/studio', defer: true })
    await page.evaluate(() => {
      const { canvasFixture, projectFixture } = window.__mock.fixtures
      const layout = canvasFixture({ id: 'canvas-1', title: '画面 1', prompt: '一只橘猫坐在窗台上', modelBundleId: 'combo-moved' })
      window.__mock.state.projects = [projectFixture({ id: 'project-1', name: '小猫', canvases: [layout], selectedCanvasId: 'canvas-1' })]
    })
    await app.start()
    const blocker = page.locator('li', { hasText: '找不到「moss_image_sft_int8」' })
    await expect.poll(() => blocker.isVisible()).toBe(true)
    expect(await blocker.textContent()).toContain('（E:\\Models\\moss_image_sft_int8.safetensors）。插上那块硬盘，或重新找到它。')
    await blocker.getByRole('button', { name: '重新找到…' }).click()
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/models?bundle=combo-moved')
  })

  it('移除 takes the model off the list after a confirm, leaving the files alone', async () => {
    const page = await app.open({ scenario: 'modelFileMoved', route: '/models' })
    await page.getByRole('button', { name: '移除 我的 INT8' }).click()
    const confirm = page.getByRole('dialog', { name: '移除「我的 INT8」？' })
    expect(await confirm.getByText('只从模型库里移除，电脑上的文件不会被删除。').isVisible()).toBe(true)
    await confirm.getByRole('button', { name: '移除' }).click()
    await expect.poll(() => app.calls('models:forget')).toEqual([{ bundleId: 'combo-moved' }])
    await expect.poll(() => page.getByText('我的 INT8我的组合', { exact: true }).count()).toBe(0)
  })
})
