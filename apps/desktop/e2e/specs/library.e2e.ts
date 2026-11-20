/**
 * 作品: the list and its filters, the detail panel with ← →, 在创作中复用 and 删除.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { useApp } from '../support/app'

const hash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash)

describe('library', () => {
  const app = useApp()

  async function openLibrary(): Promise<Page> {
    const page = await app.open({ scenario: 'ready', route: '/library', theme: 'light', defer: true })
    await page.evaluate(() => {
      const { galleryItemFixture } = window.__mock.fixtures
      window.__mock.state.gallery = [0, 1, 2, 3].map((index) => ({
        ...galleryItemFixture(index, {
          prompt: ['海边的灯塔', '雨夜街道', '森林小径', '雪山湖泊'][index],
          seed: 1000 + index,
          projectId: index < 2 ? 'project-1' : undefined,
        }),
        // The detail panel shows the negative prompt as a second block, like the prompt.
        ...(index === 0 ? { negativePrompt: '模糊，水印' } : {}),
      }))
      window.__mock.state.projects = [window.__mock.fixtures.projectFixture({ id: 'project-1', name: '风景' })]
    })
    await app.start()
    await page.getByRole('heading', { name: '作品' }).waitFor()
    return page
  }

  const tiles = (page: Page) => page.locator('[data-library-item]')

  it('lists images and filters them by text, project and time', async () => {
    const page = await openLibrary()
    await expect.poll(() => tiles(page).count()).toBe(4)
    await expect.poll(() => page.getByText('4 张').isVisible()).toBe(true)

    await page.getByRole('searchbox').fill('雨夜')
    await expect.poll(() => tiles(page).count()).toBe(1)
    await expect.poll(() => app.calls<{ query?: string }>('gallery:list').then((calls) => calls.at(-1)?.query)).toBe('雨夜')

    // Nothing matches: say so and offer to clear.
    await page.getByRole('searchbox').fill('不存在的图片')
    await expect.poll(() => tiles(page).count()).toBe(0)
    await page.getByRole('button', { name: '清除筛选' }).click()
    await expect.poll(() => tiles(page).count()).toBe(4)

    await page.getByRole('combobox', { name: '按项目筛选' }).selectOption({ label: '风景' })
    await expect.poll(() => app.calls<{ projectId?: string }>('gallery:list').then((calls) => calls.at(-1)?.projectId)).toBe('project-1')
    await expect.poll(() => tiles(page).count()).toBe(2)
    await page.getByRole('combobox', { name: '按项目筛选' }).selectOption({ label: '全部项目' })

    const times = await page.getByRole('combobox', { name: '按时间筛选' }).locator('option').allTextContents()
    expect(times.length).toBeGreaterThan(1)
    await page.getByRole('combobox', { name: '按时间筛选' }).selectOption({ index: 1 })
    await expect.poll(() => app.calls<{ since?: number }>('gallery:list').then((calls) => typeof calls.at(-1)?.since)).toBe('number')
  })

  it('steps through the detail panel with ← → and the buttons', async () => {
    const page = await openLibrary()
    await tiles(page).first().click()
    const detail = page.getByRole('complementary', { name: '作品详情' })
    await expect.poll(() => detail.getByText('1 / 4').isVisible()).toBe(true)
    await expect.poll(() => detail.getByText('海边的灯塔').count()).toBeGreaterThan(0)
    // Prompt and negative prompt are the same kind of block, each with a copy button.
    await expect.poll(() => detail.locator('[data-prompt-block="不想出现的内容"]').getByText('模糊，水印').isVisible()).toBe(true)
    expect(await detail.getByRole('button', { name: '复制描述' }).isVisible()).toBe(true)
    expect(await detail.getByRole('button', { name: '复制不想出现的内容' }).isVisible()).toBe(true)
    await app.screenshot('library-detail-light')

    await page.keyboard.press('ArrowRight')
    await expect.poll(() => detail.getByText('2 / 4').isVisible()).toBe(true)
    await expect.poll(() => detail.getByText('雨夜街道').count()).toBeGreaterThan(0)
    await detail.getByRole('button', { name: '下一张（→）' }).click()
    await expect.poll(() => detail.getByText('3 / 4').isVisible()).toBe(true)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => detail.getByText('2 / 4').isVisible()).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => detail.count()).toBe(0)
  })

  it('reuses an image in 创作 as a new, prefilled canvas', async () => {
    const page = await openLibrary()
    // Visit 创作 first so it has a project with one canvas.
    await page.getByRole('button', { name: '创作' }).click()
    await page.locator('[data-project-switcher]').waitFor()
    const cards = page.locator('article[data-canvas-card]')
    const before = await cards.count()
    await page.getByRole('button', { name: '作品' }).click()

    await tiles(page).nth(1).click()
    const detail = page.getByRole('complementary', { name: '作品详情' })
    const reuse = detail.getByRole('button', { name: '在创作中复用' })
    await expect.poll(() => reuse.isEnabled()).toBe(true)
    await reuse.click()
    await expect.poll(() => hash(page)).toBe('#/studio')
    await expect.poll(() => cards.count()).toBe(before + 1)
    await expect.poll(() => page.getByRole('textbox', { name: '描述', exact: true }).inputValue()).toBe('雨夜街道')
    // The new canvas is the selected one, with the image's seed kept.
    expect(await page.locator('article[data-canvas-card][aria-current="true"]').count()).toBe(1)
    await page.getByRole('button', { name: /高级/ }).click()
    await expect.poll(() => page.getByRole('textbox', { name: '种子' }).inputValue()).toBe('1001')
  })

  it('用作描图 puts the picture under the selected 画面 in 创作, to trace over', async () => {
    const page = await openLibrary()
    await page.getByRole('button', { name: '创作' }).click()
    await page.locator('[data-project-switcher]').waitFor()
    await page.getByRole('button', { name: '作品' }).click()
    await tiles(page).nth(1).click()
    await page.getByRole('complementary', { name: '作品详情' }).getByRole('button', { name: '用作描图' }).click()
    await expect.poll(() => hash(page)).toBe('#/studio')
    await expect
      .poll(() => page.evaluate(() => window.__mock.state.projects[0]?.canvases.map((canvas) => canvas.backgroundPath ?? null)), {
        timeout: 10_000,
      })
      .toEqual(['/fixture/outputs/moss_0001.png'])
  })

  it('deletes after confirmation, moving the file to the trash', async () => {
    const page = await openLibrary()
    await tiles(page).nth(2).click()
    const detail = page.getByRole('complementary', { name: '作品详情' })
    await detail.getByRole('button', { name: '删除' }).click()
    const confirm = page.getByRole('dialog')
    await expect.poll(() => confirm.getByText('删除这张图片？').isVisible()).toBe(true)
    await app.screenshot('library-delete-confirm-light')
    // 取消 leaves it alone.
    await confirm.getByRole('button', { name: '取消' }).click()
    expect(await app.calls('gallery:trash')).toEqual([])

    await detail.getByRole('button', { name: '删除' }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^移到/ }).click()
    await expect.poll(() => app.calls<{ path: string }>('gallery:trash')).toEqual([{ path: '/fixture/outputs/moss_0002.png' }])
    await expect.poll(() => tiles(page).count()).toBe(3)
    await expect.poll(() => page.getByText('3 张').isVisible()).toBe(true)
  })

  const pathOf = (index: number): string => `/fixture/outputs/moss_000${index}.png`
  const bar = (page: Page) => page.getByRole('toolbar', { name: '已选作品' })
  const pickedPaths = (page: Page) =>
    page
      .locator('[data-library-item][aria-pressed="true"]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-library-item')))

  it('picks several with Shift and Ctrl clicks; the bar takes the panel’s place and Esc lets go', async () => {
    const page = await openLibrary()
    await tiles(page).nth(0).click()
    const detail = page.getByRole('complementary', { name: '作品详情' })
    await expect.poll(() => detail.count()).toBe(1)

    await tiles(page)
      .nth(2)
      .click({ modifiers: ['Shift'] })
    await expect.poll(() => pickedPaths(page)).toEqual([pathOf(0), pathOf(1), pathOf(2)])
    await expect.poll(() => bar(page).getByText('已选 3 张').isVisible()).toBe(true)
    expect(await detail.count()).toBe(0)
    // Each picked tile carries the accent ring and a check.
    expect(await page.locator('[data-library-item] [data-picked-badge]').count()).toBe(3)

    await tiles(page)
      .nth(1)
      .click({ modifiers: ['Control'] })
    await expect.poll(() => pickedPaths(page)).toEqual([pathOf(0), pathOf(2)])
    await expect.poll(() => bar(page).getByText('已选 2 张').isVisible()).toBe(true)
    // No 复制 for several pictures: several files on the clipboard do not paste alike everywhere.
    expect(await bar(page).getByRole('button', { name: /复制/ }).count()).toBe(0)

    await page.keyboard.press('Escape')
    await expect.poll(() => pickedPaths(page)).toEqual([])
    expect(await bar(page).count()).toBe(0)
  })

  it('draws a box from empty space to pick the tiles it touches', async () => {
    const page = await openLibrary()
    const first = (await tiles(page).nth(0).boundingBox())!
    const second = (await tiles(page).nth(1).boundingBox())!
    // From below the row, up across the first two tiles.
    await page.mouse.move(first.x + 10, first.y + first.height + 40)
    await page.mouse.down()
    await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 6 })
    await expect.poll(() => pickedPaths(page)).toEqual([pathOf(0), pathOf(1)])
    await page.mouse.up()
    await expect.poll(() => bar(page).getByText('已选 2 张').isVisible()).toBe(true)
    // A click on empty space lets them go.
    await page.mouse.click(first.x + 10, first.y + first.height + 40)
    await expect.poll(() => pickedPaths(page)).toEqual([])
  })

  it('exports the picked pictures to a folder, with their 生成参数 when asked', async () => {
    const page = await openLibrary()
    await tiles(page).nth(1).click()
    await tiles(page)
      .nth(3)
      .click({ modifiers: ['Control'] })
    const menu = bar(page).getByRole('button', { name: '导出内容' })
    await menu.click()
    const choices = page.getByRole('menu', { name: '导出内容' })
    // 只导出图片 is the default.
    expect(await choices.getByRole('menuitem', { name: '只导出图片' }).getAttribute('aria-current')).toBe('true')
    await app.screenshot('library-export-menu-light')
    await choices.getByRole('menuitem', { name: '连同生成参数' }).click()
    await bar(page).getByRole('button', { name: '导出到文件夹…' }).click()
    await expect.poll(() => app.calls('gallery:export')).toEqual([{ paths: [pathOf(1), pathOf(3)], withParams: true }])
    await expect.poll(() => page.getByText('已导出 2 张').isVisible()).toBe(true)
  })

  it('keeps the bar and its progress while an export copies, even when the picks are let go', async () => {
    const page = await openLibrary()
    await page.evaluate(() => {
      ;(window as unknown as { heldExport: unknown }).heldExport = window.__mock.hold('gallery:export')
    })
    await tiles(page).nth(0).click()
    await tiles(page)
      .nth(1)
      .click({ modifiers: ['Control'] })
    await bar(page).getByRole('button', { name: '导出到文件夹…' }).click()
    await page.evaluate(() => window.__mock.emit(window.__mock.Events.galleryExport, { done: 1, total: 2 }))
    await expect.poll(() => bar(page).getByRole('progressbar', { name: '导出进度' }).isVisible()).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => pickedPaths(page)).toEqual([])
    // Still copying: the bar stays, and a second export cannot start.
    expect(await bar(page).isVisible()).toBe(true)
    expect(await bar(page).getByRole('button', { name: '导出到文件夹…' }).isDisabled()).toBe(true)
    await page.evaluate(() => (window as unknown as { heldExport: { release: () => Promise<void> } }).heldExport.release())
    await expect.poll(() => page.getByText('已导出 2 张').isVisible()).toBe(true)
    await expect.poll(() => bar(page).count()).toBe(0)
    expect(await app.calls('gallery:export')).toHaveLength(1)
  })

  it('deletes the picked pictures after one confirmation', async () => {
    const page = await openLibrary()
    await tiles(page).nth(0).click()
    await tiles(page)
      .nth(1)
      .click({ modifiers: ['Control'] })
    await bar(page).getByRole('button', { name: '删除' }).click()
    const confirm = page.getByRole('dialog')
    await expect.poll(() => confirm.getByText('删除这 2 张图片？').isVisible()).toBe(true)
    await confirm.getByRole('button', { name: /^移到/ }).click()
    await expect.poll(() => app.calls<{ path: string }>('gallery:trash')).toEqual([{ path: pathOf(0) }, { path: pathOf(1) }])
    await expect.poll(() => tiles(page).count()).toBe(2)
    expect(await bar(page).count()).toBe(0)
  })

  it('drags pictures out as files: the picks when the tile is one of them, else that tile', async () => {
    const page = await openLibrary()
    await tiles(page).nth(0).click()
    await tiles(page)
      .nth(2)
      .click({ modifiers: ['Control'] })
    await tiles(page).nth(2).dispatchEvent('dragstart')
    await tiles(page).nth(3).dispatchEvent('dragstart')
    await expect.poll(() => app.calls('gallery:start-drag')).toEqual([{ paths: [pathOf(0), pathOf(2)] }, { paths: [pathOf(3)] }])
  })

  it('right-click on a picture: 复制图片, 另存为… and 在文件夹中显示', async () => {
    const page = await openLibrary()
    await tiles(page).nth(1).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: '图片操作' })
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['复制图片', '另存为…', '在文件夹中显示'])
    // The picture right-clicked becomes the pick.
    expect(await pickedPaths(page)).toEqual([pathOf(1)])
    await menu.getByRole('menuitem', { name: '复制图片' }).click()
    await expect.poll(() => app.calls('gallery:copy-image')).toEqual([{ path: pathOf(1) }])
    await expect.poll(() => page.getByText('已复制图片').isVisible()).toBe(true)

    await tiles(page).nth(1).click({ button: 'right' })
    await page.getByRole('menu', { name: '图片操作' }).getByRole('menuitem', { name: '另存为…' }).click()
    await expect.poll(() => app.calls('gallery:save-as')).toEqual([{ path: pathOf(1) }])
    await tiles(page).nth(1).click({ button: 'right' })
    await page.getByRole('menu', { name: '图片操作' }).getByRole('menuitem', { name: '在文件夹中显示' }).click()
    await expect.poll(() => app.calls('gallery:reveal')).toEqual([{ path: pathOf(1) }])
  })
})
