import { describe, it, expect } from 'vitest'
import { useApp } from '../support/app'

describe('external redraw', () => {
  const app = useApp()
  it.each(['light', 'dark'] as const)('opts in, probes, chooses a model and redraws an image in %s', async (theme) => {
    const page = await app.open({ scenario: 'ready', theme, route: '/settings/features', defer: true })
    await page.evaluate(() => {
      const { canvasFixture, projectFixture } = window.__mock.fixtures
      const pic = canvasFixture({
        id: 'src',
        kind: 'result',
        pinned: true,
        width: 1536,
        outputs: [
          { path: '/fixture/outputs/first-800x600.png', width: 800, height: 600, seed: 1 },
          { path: '/fixture/outputs/second-640x480.png', width: 640, height: 480, seed: 2 },
        ],
      })
      window.__mock.state.projects = [projectFixture({ id: 'proj', canvases: [pic], selectedCanvasId: 'src' })]
    })
    await app.start()
    expect(await page.getByLabel('渠道名称').count()).toBe(0)
    expect(await app.calls('image-edit:channels-list')).toEqual([])
    await page.getByRole('switch', { name: '外接重绘' }).click()
    await page.getByLabel('渠道名称').fill('我的渠道')
    await page.getByLabel('接口地址').fill('https://image.example/v1')
    await page.getByLabel('API Key').fill('test-only')
    await page.getByRole('button', { name: '探测模型' }).click()
    await page.getByLabel('探测结果').selectOption('image-test')
    await page.getByRole('button', { name: '保存渠道' }).click()
    await expect.poll(() => page.getByLabel('API Key').inputValue()).toBe('')
    await page.evaluate(() => {
      window.location.hash = '#/studio'
    })
    const card = page.locator('article[data-canvas-card="src"]')
    const second = card.getByRole('button', { name: '第 2 张', exact: true })
    if (theme === 'light') {
      await second.hover()
      await second.click({ button: 'right' })
    } else {
      await second.focus()
      await card.getByRole('button', { name: /更多操作/ }).click()
    }
    await page.getByText('外接重绘…', { exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '外接重绘' })
    const source = '/fixture/outputs/second-640x480.png'
    expect(await dialog.getByRole('img').getAttribute('src')).toBe(`clover://local?path=${encodeURIComponent(source)}`)
    await dialog.getByText('second-640x480.png', { exact: false }).waitFor()
    await dialog.getByText('640 × 480', { exact: false }).waitFor()
    await app.screenshot(`external-redraw-preview-${theme}`)
    await dialog.getByText(/将图片和描述上传到 https:\/\/image.example/).waitFor()
    await dialog.getByLabel('重绘描述').fill('把背景换成蓝色')
    await dialog.getByRole('button', { name: '发送并重绘' }).click()
    await expect.poll(() => page.locator('article[data-canvas-card]').count()).toBe(2)
    expect(await app.calls('image-edit:run')).toEqual([expect.objectContaining({ path: source })])
    await app.screenshot(`external-redraw-${theme}`)
    // 取消 while the service is still generating closes the dialog and stops that run; it adds no card.
    await page.locator('article[data-canvas-card="src"]').click({ button: 'right' })
    await page.getByText('外接重绘…', { exact: true }).click()
    await page.evaluate(() => {
      ;(window as unknown as { redraw: unknown }).redraw = window.__mock.hold('image-edit:run')
    })
    await dialog.getByLabel('重绘描述').fill('取消')
    await dialog.getByRole('button', { name: '发送并重绘' }).click()
    await dialog.getByRole('button', { name: '正在重绘…' }).waitFor()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.locator('dialog.app-dialog').waitFor({ state: 'detached' })
    const [, held] = (await app.calls('image-edit:run')) as Array<{ runId: string }>
    expect(await app.calls('image-edit:cancel')).toEqual([{ runId: held!.runId }])
    await page.evaluate(() => (window as unknown as { redraw: { release: () => Promise<void> } }).redraw.release())
    expect(await page.locator('article[data-canvas-card]').count()).toBe(2)
    // Simulate navigating away while the service is still generating. Its result belongs to the first board.
    await page.locator('article[data-canvas-card="src"]').click({ button: 'right' })
    await page.getByText('外接重绘…', { exact: true }).click()
    await page.evaluate(() => {
      ;(window as unknown as { redraw: unknown }).redraw = window.__mock.hold('image-edit:run')
    })
    await dialog.getByLabel('重绘描述').fill('延迟')
    await dialog.getByRole('button', { name: '发送并重绘' }).click()
    await expect.poll(() => app.calls('image-edit:run')).toHaveLength(3)
    await page.evaluate(() => {
      window.location.hash = '#/settings/features'
    })
    await page.getByLabel('选择渠道').waitFor()
    // Leaving the Studio closes the dialog; the page learns it is hidden from a ResizeObserver, a frame later.
    await page.locator('dialog.app-dialog').waitFor({ state: 'detached' })
    await expect.poll(() => app.calls('image-edit:cancel')).toHaveLength(2)
    await page.evaluate(() => {
      window.location.hash = '#/studio'
    })
    await page.locator('[data-project-switcher]').click()
    await page.getByRole('menuitem', { name: '新建项目' }).click()
    await page
      .getByRole('button', { name: /未命名项目/ })
      .first()
      .waitFor()
    await page.evaluate(() => (window as unknown as { redraw: { release: () => Promise<void> } }).redraw.release())
    await expect.poll(() => page.locator('article[data-canvas-card]').count()).toBe(1)
  })
})
