import { describe, expect, it } from 'vitest'
import { panelRequest } from '@renderer/pages/manga/submit'
import type { AdapterEntry, Catalog, EngineFeatures } from '@shared/types'
import { SFT_BUNDLE_IDS, catalogFixture } from '../../mocks/backend/fixtures'
import { mangaSeriesFixture } from '../../mocks/backend/manga'

const lora = (id: string, installed = true): AdapterEntry => ({
  id,
  name: `LoRA ${id}`,
  provider: 'local',
  repo: '',
  revision: '',
  kind: 'lora',
  license: '',
  files: [],
  sizeBytes: 1,
  tags: [],
  installed,
  installedBytes: installed ? 1 : 0,
})

function catalog(adapters: AdapterEntry[] = [lora('ink-style'), lora('aki-lora')]): Catalog {
  const base = catalogFixture({ installed: SFT_BUNDLE_IDS })
  return { ...base, adapters }
}

const features = (patch: Partial<EngineFeatures> = {}): EngineFeatures =>
  ({
    preview: true,
    imageInput: true,
    control: true,
    references: true,
    visionReferences: true,
    hires: true,
    samplers: true,
    lora: true,
    ...patch,
  }) as EngineFeatures

const series = mangaSeriesFixture()
const chapter = series.chapters[0]!
const page = chapter.pages[0]!

function request(patch: Partial<Parameters<typeof panelRequest>[0]> = {}) {
  return panelRequest({
    series,
    chapter,
    page,
    panel: page.panels[0]!,
    catalog: catalog(),
    preferredBundleId: null,
    features: features(),
    random: () => 0.5,
    ...patch,
  })
}

describe('panelRequest', () => {
  it('builds the engine job of a panel: description, LoRA, references and its shape on the page', () => {
    const result = request()
    if (!result.ok) throw new Error(result.message)
    expect(result.notes).toEqual([])
    expect(result.body).toMatchObject({
      projectId: 'project-manga',
      canvasId: 'panel-1',
      canvasTitle: '雨夜侦探 第 1 话 第 1 页 第 1 格',
      negativePrompt: '彩色，文字，对白框，水印',
      adapters: [
        { id: 'ink-style', strength: 1 },
        { id: 'aki-lora', strength: 0.8 },
      ],
      visionReferences: { paths: ['/fixture/projects/project-manga/assets/aki.png'] },
      seed: 1073741823,
      mode: 'runner',
    })
    expect(String(result.body['prompt'])).toContain('雨夜的街道')
    // The first panel of 一宽两窄 spans the page: wider than tall.
    expect(Number(result.body['width'])).toBeGreaterThan(Number(result.body['height']))
    // The narrow second panel is taller than wide.
    const narrow = request({ panel: page.panels[1]! })
    if (!narrow.ok) throw new Error(narrow.message)
    expect(Number(narrow.body['height'])).toBeGreaterThan(Number(narrow.body['width']))
  })

  it('leaves out what the engine cannot do, and says so', () => {
    const result = request({ features: features({ lora: false, visionReferences: false }) })
    if (!result.ok) throw new Error(result.message)
    expect(result.body['adapters']).toEqual([])
    expect(result.body).not.toHaveProperty('visionReferences')
    expect(result.notes).toEqual([
      '当前引擎不支持 LoRA，这一格没有用人物和画风的 LoRA',
      '当前引擎还不支持人物参考图，这一格只用了文字描述和 LoRA',
    ])
    // Edit-adapter references are never sent: without an edit adapter the engine ignores them.
    expect(result.body).not.toHaveProperty('references')
    // An engine that does not say (an older one, or unknown) gets no pictures either.
    const unknown = request({ features: null })
    if (!unknown.ok) throw new Error(unknown.message)
    expect(unknown.body).not.toHaveProperty('visionReferences')
  })

  it('waits for the model library instead of failing while it is still being read', () => {
    expect(request({ catalog: null })).toEqual({ ok: false, message: '正在读取模型库…', retry: true })
  })

  it('refuses without retrying when the model or a LoRA is missing, or the panel is empty', () => {
    expect(request({ catalog: catalogFixture() })).toEqual({ ok: false, message: '还没有可用的模型，请先到模型页下载', retry: false })
    expect(request({ catalog: catalog([lora('ink-style')]) })).toEqual({
      ok: false,
      message: 'LoRA 「aki-lora」找不到了，请移除或到模型库重新安装',
      retry: false,
    })
    expect(request({ panel: { ...page.panels[0]!, scene: '' } })).toMatchObject({ ok: false, message: '这一格还没有画面描述' })
    const gone = { ...series, style: { ...series.style, modelBundleId: 'removed-bundle' } }
    expect(request({ series: gone })).toMatchObject({ ok: false, message: '这部漫画用的模型已经不在模型库里，请在「设定」里换一个' })
  })
})
