import type { Page } from 'playwright-core'

/**
 * A saved project with one 画面 that uses a LoRA whose trigger word is
 * remembered, and the 协同 conversation of the externalAgents scenario bound to
 * it. With `workerHost`, the LoRA is the Worker's and the Worker is the 运行位置.
 */
export async function seedLoraBoard(page: Page, options: { workerHost?: boolean } = {}): Promise<void> {
  await page.evaluate((worker) => {
    const { canvasFixture, projectFixture, localAdapterFixture } = window.__mock.fixtures
    const lora = worker ? { id: 'styles/ink.safetensors', strength: 1 } : { id: 'local-lora-ink', strength: 0.8 }
    const card = canvasFixture({ id: 'c1', title: '画面 1', prompt: '海边的小镇', adapters: [lora] })
    window.__mock.state.projects = [projectFixture({ id: 'p1', name: '海报', canvases: [card], selectedCanvasId: 'c1' })]
    window.__mock.state.catalog.adapters = [...window.__mock.state.catalog.adapters, localAdapterFixture()]
    window.__mock.state.loraProfiles = [{ loraId: 'local-lora-ink', triggers: ['ink style'], autoInsert: 'manual' }]
    localStorage.setItem('mossstudio.collab.session.codex-acp.p1', 'session-1')
    localStorage.setItem('mossstudio.collab.pinned.codex-acp.p1', JSON.stringify(['session-1']))
    localStorage.setItem('mossstudio.collab.backend', 'codex-acp')
    if (worker) localStorage.setItem('mossstudio.studioHostId', 'worker-1')
  }, options.workerHost === true)
}

/** Opens the 助手 beside the board, then its 协同 panel. */
export async function openCollab(page: Page): Promise<void> {
  await page.getByRole('button', { name: '助手', exact: true }).click()
  // The sidebar remembers 协同 from an earlier run in the same profile.
  const panel = page.locator('[data-collab-panel]')
  const toggle = page.locator('[data-collab-toggle]')
  await panel.or(toggle).first().waitFor()
  if (!(await panel.count())) await toggle.click()
  await panel.waitFor()
}

/** Opens the selected 画面's model, size and LoRA settings, where each LoRA row and its trigger words are. */
export async function openLoraRows(page: Page): Promise<void> {
  const summary = page.locator('[data-settings-summary]').first()
  await summary.waitFor()
  if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click()
  await page.locator('[data-adapter-picker]').first().waitFor()
}
