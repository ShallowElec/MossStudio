import { describe, expect, it } from 'vitest'
import type { ProjectCanvas } from '@shared/types'
import { cliEngineFeatures } from '@shared/cliEngine'
import { MAX_PIXELS } from '@shared/imageGeometry'
import { inputStillDrawing, resolveJobInputs, type JobInputContext } from '@renderer/pages/studio/jobInputs'
import { controlAdapterFixture, engineFeaturesFixture } from '@test/mocks/backend'
import { canvas } from './fixtures'

const out = (path: string) => ({ path, width: 1024, height: 1024, seed: 1 })
const image = canvas({ id: 'img', kind: 'image', title: '猫', imagePath: '/assets/cat.png' })
const done = canvas({ id: 'done', kind: 'result', title: '画面 2', outputs: [out('/o/a.png'), out('/o/b.png')] })
const empty = canvas({ id: 'empty', title: '画面 3' })
const running = canvas({ id: 'run', kind: 'result', title: '画面 4', jobState: 'running', outputs: [] })
const adapter = controlAdapterFixture()

function context(patch: Partial<JobInputContext> = {}): JobInputContext {
  return {
    canvases: [image, done, empty, running],
    features: engineFeaturesFixture(),
    controlAdapters: [adapter],
    controlAdaptersLoaded: true,
    ...patch,
  }
}

function target(patch: Partial<ProjectCanvas> = {}): ProjectCanvas {
  return canvas({ id: 't', ...patch })
}

describe('studio/jobInputs resolution', () => {
  it('sends nothing extra for a plain canvas', () => {
    expect(resolveJobInputs(target(), context())).toEqual({
      params: {},
      size: { width: 1024, height: 1024 },
      output: { width: 1024, height: 1024 },
      blockers: [],
    })
  })

  it('resolves every link to its source picture and the adapter id to its file', () => {
    const resolved = resolveJobInputs(
      target({
        inputs: {
          init: { link: { canvasId: 'done', output: 1 }, strength: 0.45, resize: 'fit' },
          mask: { path: '/assets/mask-t.png' },
          control: {
            adapterId: adapter.id,
            loraStrength: 0.8,
            images: [{ kind: 'depth', link: { canvasId: 'img' }, strength: 1.2, start: 0.1, end: 0.9 }],
          },
          references: { links: [{ canvasId: 'img' }, { canvasId: 'done' }], maxEdge: 768 },
        },
        sampling: { sampler: 'euler', scheduler: 'karras', shift: 3, stepCache: 'fbcache', cfgTruncation: 0.5 },
      }),
      context(),
    )
    expect(resolved.blockers).toEqual([])
    expect(resolved.params).toEqual({
      initImage: { path: '/o/b.png', strength: 0.45, resize: 'fit' },
      mask: { path: '/assets/mask-t.png' },
      control: {
        adapter: adapter.path,
        loraStrength: 0.8,
        images: [{ kind: 'depth', path: '/assets/cat.png', strength: 1.2, start: 0.1, end: 0.9 }],
      },
      references: { paths: ['/assets/cat.png', '/o/a.png'], maxEdge: 768 },
      sampling: { sampler: 'euler', scheduler: 'karras', shift: 3, stepCache: 'fbcache', cfgTruncation: 0.5 },
    })
  })

  it('blocks with a reason while a source has no picture, never dropping the input', () => {
    const notYet = resolveJobInputs(target({ inputs: { init: { link: { canvasId: 'empty' }, strength: 0.6 } } }), context())
    expect(notYet.params.initImage).toBeUndefined()
    expect(notYet.blockers).toEqual([{ id: 'input-source', message: '起始图「画面 3」还没生成' }])
    const generating = resolveJobInputs(target({ inputs: { references: { links: [{ canvasId: 'run' }] } } }), context())
    expect(generating.blockers[0]!.message).toBe('参考图 1「画面 4」还在生成，完成后再试')
    const gone = resolveJobInputs(
      target({
        inputs: {
          control: { adapterId: adapter.id, images: [{ kind: 'pose', link: { canvasId: 'nope' }, strength: 1, start: 0, end: 1 }] },
        },
      }),
      context(),
    )
    expect(gone.blockers[0]!.message).toBe('控制图 · 姿态找不到了，请重新选择')
  })

  it('blocks a mask without a start picture', () => {
    const resolved = resolveJobInputs(target({ inputs: { mask: { path: '/m.png' } } }), context())
    expect(resolved.blockers).toEqual([{ id: 'input-invalid', message: '遮罩需要先设置起始图' }])
    expect(resolved.params.mask).toBeUndefined()
  })

  it('needs a registered control adapter that knows each kind, one image per kind', () => {
    const image = (kind: string) => ({ kind, link: { canvasId: 'img' }, strength: 1, start: 0, end: 1 })
    expect(
      resolveJobInputs(target({ inputs: { control: { adapterId: '', images: [image('depth')] } } }), context()).blockers[0]!.message,
    ).toBe('请选择控制适配器')
    const missing = resolveJobInputs(target({ inputs: { control: { adapterId: 'gone', images: [image('depth')] } } }), context())
    expect(missing.blockers[0]).toMatchObject({ id: 'input-adapter', action: { to: '/models' } })
    expect(missing.params.control).toBeUndefined()
    // Before the list has loaded it waits (never sends the job without its control image).
    expect(
      resolveJobInputs(
        target({ inputs: { control: { adapterId: 'gone', images: [image('depth')] } } }),
        context({ controlAdapters: [], controlAdaptersLoaded: false }),
      ).blockers,
    ).toEqual([{ id: 'input-adapter', message: '正在读取控制适配器…' }])
    const wrongKind = resolveJobInputs(target({ inputs: { control: { adapterId: adapter.id, images: [image('scribble')] } } }), context())
    expect(wrongKind.blockers[0]!.message).toContain('不支持scribble控制')
    const twice = resolveJobInputs(
      target({ inputs: { control: { adapterId: adapter.id, images: [image('depth'), image('depth')] } } }),
      context(),
    )
    expect(twice.blockers.map((blocker) => blocker.message)).toEqual(['「深度」控制图只能接一张'])
    expect(twice.params.control?.images).toHaveLength(1)
    // An adapter picked with no images yet sends nothing and blocks nothing.
    expect(resolveJobInputs(target({ inputs: { control: { adapterId: adapter.id, images: [] } } }), context())).toMatchObject({
      params: {},
      blockers: [],
    })
  })

  it('keeps control numbers inside the engine limits', () => {
    const resolved = resolveJobInputs(
      target({
        inputs: {
          control: { adapterId: adapter.id, images: [{ kind: 'depth', link: { canvasId: 'img' }, strength: 40, start: 0.8, end: 0.2 }] },
        },
      }),
      context(),
    )
    expect(resolved.params.control?.images[0]).toMatchObject({ strength: 10, start: 0.8, end: 0.8 })
  })

  it('blocks more than 4 references', () => {
    const links = ['img', 'done', 'img', 'done', 'img'].map((canvasId, output) => ({ canvasId, output }))
    expect(resolveJobInputs(target({ inputs: { references: { links } } }), context()).blockers[0]!.message).toBe(
      '参考图最多 4 张，请移除多出来的',
    )
  })

  it('blocks what the engine says it cannot do, and names it', () => {
    const features = engineFeaturesFixture({ imageInput: false, control: false, references: false, hires: false, samplers: false })
    const resolved = resolveJobInputs(
      target({
        inputs: {
          init: { link: { canvasId: 'img' }, strength: 0.6 },
          control: { adapterId: adapter.id, images: [{ kind: 'depth', link: { canvasId: 'img' }, strength: 1, start: 0, end: 1 }] },
          references: { links: [{ canvasId: 'img' }] },
        },
        sampling: { sampler: 'euler', hires: { width: 2048, height: 2048 } },
      }),
      context({ features }),
    )
    expect(resolved.blockers.map((blocker) => blocker.message)).toEqual([
      '这台设备上的引擎不支持起始图，请移除后再生成',
      '这台设备上的引擎不支持控制图，请移除后再生成',
      '这台设备上的引擎不支持参考图，请移除后再生成',
      '这台设备上的引擎不支持更换采样器，请移除后再生成',
      '这台设备上的引擎不支持高清修复，请移除后再生成',
    ])
  })

  it('blocks a sampling name the engine does not list', () => {
    const resolved = resolveJobInputs(target({ sampling: { sampler: 'dpmpp_3m', stepCache: 'teacache' } }), context())
    expect(resolved.blockers.map((blocker) => blocker.message)).toEqual([
      '采样器「dpmpp_3m」这个引擎不支持，请改回默认',
      '步缓存「teacache」这个引擎不支持，请改回默认',
    ])
  })

  it('treats an empty name list from the engine as unknown, not as "nothing allowed"', () => {
    const features = engineFeaturesFixture({ values: { sampler: [], scheduler: [], step_cache: [] } })
    expect(
      resolveJobInputs(target({ sampling: { sampler: 'euler', scheduler: 'karras', stepCache: 'fbcache' } }), context({ features }))
        .blockers,
    ).toEqual([])
  })

  it('does not judge features while they are unknown (the engine blocker covers that)', () => {
    const resolved = resolveJobInputs(
      target({ inputs: { init: { link: { canvasId: 'img' }, strength: 0.6 } }, sampling: { sampler: 'anything' } }),
      context({ features: null }),
    )
    expect(resolved.blockers).toEqual([])
  })

  it('reports the first-pass and output sizes for 高清修复', () => {
    const resolved = resolveJobInputs(
      target({ width: 1024, height: 768, sampling: { hires: { width: 2048, height: 1536, strength: 0.3 } } }),
      context(),
    )
    expect(resolved.size).toEqual({ width: 1024, height: 768 })
    expect(resolved.output).toEqual({ width: 2048, height: 1536 })
    expect(resolved.params.sampling).toEqual({ hires: { width: 2048, height: 1536, strength: 0.3 } })
    const rerun = resolveJobInputs(
      target({
        kind: 'result',
        width: 2048,
        height: 1536,
        baseSize: { width: 1024, height: 768 },
        sampling: { hires: { width: 2048, height: 1536 } },
      }),
      context(),
    )
    expect(rerun.size).toEqual({ width: 1024, height: 768 })
  })

  it('fits a 高清修复 target saved over the engine pixel budget, keeping its shape', () => {
    const square = resolveJobInputs(
      target({ width: 2048, height: 2048, sampling: { hires: { width: 4096, height: 4096, steps: 12, strength: 0.4 } } }),
      context(),
    )
    expect(square.size).toEqual({ width: 2048, height: 2048 })
    expect(square.output).toEqual({ width: 2048, height: 2048 })
    expect(square.params.sampling).toEqual({ hires: { width: 2048, height: 2048, steps: 12, strength: 0.4 } })
    const wide = resolveJobInputs(target({ width: 2048, height: 1024, sampling: { hires: { width: 4096, height: 2048 } } }), context())
    const hires = wide.params.sampling!.hires!
    expect(hires.width * hires.height).toBeLessThanOrEqual(MAX_PIXELS)
    expect(hires.width / hires.height).toBeCloseTo(2, 1)
    expect(wide.output).toEqual({ width: hires.width, height: hires.height })
  })
})

describe('studio/jobInputs on a Worker host', () => {
  const worker = (values: Record<string, string[]> = { sampler: ['euler'], scheduler: ['moss'] }) =>
    context({ worker: true, features: engineFeaturesFixture({ values }) })

  it.each([{ shift: 3 }, { cfgTruncation: 0 }, { stepCache: 'off' }, { hires: { width: 1536, height: 1536 } }])(
    'blocks a saved non-Worker choice %j, even before the host answers',
    (choice) => {
      const card = target({ sampling: { sampler: 'euler', ...choice } })
      for (const ctx of [worker(), { ...worker(), features: undefined }]) {
        expect(resolveJobInputs(card, ctx).blockers).toContainEqual({
          id: 'input-unsupported',
          message: expect.stringMatching(/远端.*采样器.*调度器/),
        })
      }
    },
  )

  it.each([{ sampler: 'euler' }, { scheduler: 'moss' }, { sampler: 'euler', scheduler: 'moss' }])(
    'passes negotiated choices unchanged: %j',
    (sampling) => {
      expect(resolveJobInputs(target({ sampling }), worker())).toMatchObject({ blockers: [], params: { sampling } })
    },
  )

  it.each([{ sampler: 'heun' }, { scheduler: 'moss' }])(
    'refuses an unlisted Worker choice %j, including absent or empty lists',
    (sampling) => {
      for (const ctx of [worker({ sampler: ['euler'], scheduler: [] }), worker({})])
        expect(resolveJobInputs(target({ sampling }), ctx).blockers).toMatchObject([{ id: 'input-unsupported' }])
    },
  )

  it('refuses picture inputs even without Worker capabilities or when the underlying engine advertises them', () => {
    const card = target({
      inputs: {
        init: { link: { canvasId: 'img' }, strength: 0.5 },
        control: { adapterId: adapter.id, images: [{ kind: 'depth', link: { canvasId: 'img' }, strength: 1, start: 0, end: 1 }] },
        references: { links: [{ canvasId: 'img' }] },
      },
    })
    for (const ctx of [worker(), { ...worker(), features: null }]) {
      expect(resolveJobInputs(card, ctx).blockers.map(({ message }) => message)).toEqual([
        expect.stringContaining('起始图'),
        expect.stringContaining('控制图'),
        expect.stringContaining('参考图'),
      ])
    }
  })

  it('does not guess explicit choices when the Worker cannot be queried, but allows defaults', () => {
    const ctx = { ...worker(), features: null }
    expect(resolveJobInputs(target({ sampling: { scheduler: 'moss' } }), ctx).blockers).toMatchObject([{ id: 'input-unsupported' }])
    expect(resolveJobInputs(target(), ctx)).toMatchObject({ blockers: [], params: {} })
  })
})

describe('studio/jobInputs on a CLI engine (兼容模式 / AMD 原生)', () => {
  it('blocks every picture input and sampling choice it cannot do, naming the engine', () => {
    const resolved = resolveJobInputs(
      target({
        inputs: {
          init: { link: { canvasId: 'img' }, strength: 0.6 },
          references: { links: [{ canvasId: 'img' }] },
        },
        sampling: { sampler: 'heun', hires: { width: 2048, height: 2048 }, stepCache: 'fbcache', cfgTruncation: 0.5 },
      }),
      context({ features: cliEngineFeatures('vulkan') }),
    )
    expect(resolved.blockers.map((blocker) => blocker.message)).toEqual([
      '兼容模式引擎只能文生图，不支持起始图，请移除后再生成',
      '兼容模式引擎只能文生图，不支持参考图，请移除后再生成',
      '兼容模式引擎只能文生图，不支持更换采样器，请移除后再生成',
      '兼容模式引擎只能文生图，不支持高清修复，请移除后再生成',
      '兼容模式引擎只能文生图，不支持步缓存，请移除后再生成',
      '兼容模式引擎只能文生图，不支持CFG 截断，请移除后再生成',
    ])
  })

  it('lets an explicit euler sampler and moss scheduler through: that is what the CLI runs', () => {
    const resolved = resolveJobInputs(
      target({ sampling: { sampler: 'euler', scheduler: 'moss' } }),
      context({ features: cliEngineFeatures('vulkan') }),
    )
    expect(resolved.blockers).toEqual([])
    expect(resolved.params.sampling).toEqual({ sampler: 'euler', scheduler: 'moss' })
  })

  it('lets shift and step cache off through', () => {
    const resolved = resolveJobInputs(target({ sampling: { shift: 4, stepCache: 'off' } }), context({ features: cliEngineFeatures('hip') }))
    expect(resolved.blockers).toEqual([])
    expect(resolved.params.sampling).toEqual({ shift: 4, stepCache: 'off' })
  })
})

describe('studio/jobInputs inputStillDrawing', () => {
  it('names a wired picture that is still being drawn, and nothing once it has one', () => {
    const drawing = canvas({ id: 'src', kind: 'result', title: '画面 2 · 结果', jobState: 'running', outputs: [] })
    const target = canvas({ id: 't', inputs: { init: { link: { canvasId: 'src' }, strength: 0.6 } } })
    expect(inputStillDrawing(target, [drawing, target])).toBe('「画面 2 · 结果」还在生成，完成后再试')
    const done = { ...drawing, jobState: 'succeeded' as const, outputs: [{ path: '/o.png', width: 1, height: 1, seed: 1 }] }
    expect(inputStillDrawing(target, [done, target])).toBeNull()
    expect(inputStillDrawing(canvas({ id: 'plain' }), [drawing])).toBeNull()
  })
})
