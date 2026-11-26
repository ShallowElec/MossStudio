import { mkdir, readFile, rename, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'
import { bundleWeightProblem } from '@shared/bundleFit'
import { slotChoices } from '@shared/modelCombos'
import { duplicatesImportedFile } from '@shared/sharedModels'
import { getSettings, updateSettings } from '@main/services/settings'
import { comfyModelPaths, findModelSources, guessModelSourceKind, sourceRoots } from '@main/services/modelSourcePaths'
import { probeLocalModelServices } from '@main/services/modelSourceServices'
import {
  addModelSource,
  modelSourcesView,
  refreshModelSources,
  requireSharedWeight,
  restoreModelSources,
  resolveSharedWeight,
  sharedModels,
  sharedAdapters,
  sharedControlAdapters,
} from '@main/services/modelSources'

const mocks = vi.hoisted(() => ({
  server: null as string | null,
  inspect: vi.fn(),
  discover: vi.fn(),
  engineFailure: null as Error | null,
}))
vi.mock('@main/services/modelSourcePaths', async (load) => ({
  ...(await load<typeof import('@main/services/modelSourcePaths')>()),
  nearbyModelSources: mocks.discover,
}))
vi.mock('@main/services/engineInstalls', () => ({ localServerPath: () => mocks.server }))
vi.mock('@main/lib/probeEngine', () => ({
  withEngineRequests: async (
    server: string,
    task: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<unknown>,
  ) => {
    if (mocks.engineFailure) throw mocks.engineFailure
    return task((method, params) => mocks.inspect(server, method, params))
  },
}))

const temp = useTempDir('moss-shared-sources-')

afterEach(() => {
  mocks.inspect.mockReset()
  mocks.engineFailure = null
})

describe('shared folder paths', () => {
  it('recognises ComfyUI and a WebUI without its API by what their local ports answer', async () => {
    const path = join(temp(), '自定义名称')
    const hosts = [
      createServer((_, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ system: { comfyui_version: 'fixture', argv: [join(path, 'main.py')] }, devices: [] }))
      }),
      createServer((request, response) => {
        if (request.url !== '/') {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<title>Stable Diffusion</title><script>window.gradio_config = {}</script>')
      }),
    ]
    try {
      const ports = await Promise.all(
        hosts.map(
          (host) =>
            new Promise<number>((resolve, reject) => {
              host.once('error', reject)
              host.listen(0, '127.0.0.1', () => {
                const address = host.address()
                if (address && typeof address === 'object') resolve(address.port)
                else reject(new Error('未获得本机测试端口'))
              })
            }),
        ),
      )
      expect(await probeLocalModelServices(ports)).toEqual([
        { kind: 'comfyui', port: ports[0], paths: [path] },
        { kind: 'webui', port: ports[1], paths: [] },
      ])
    } finally {
      for (const host of hosts) {
        host.close()
        host.closeAllConnections()
      }
    }
  })

  it('finds renamed clones, portable and bundled installs in the given places, but not backups or look-alike folders', async () => {
    const location = join(temp(), '下载')
    const clone = join(location, '绘画工具')
    const portable = join(location, '免安装', 'ComfyUI')
    const forge = join(location, '图像整合包', 'sd-webui-forge-classic')
    const backup = join(location, 'ComfyUI_backup')
    const falseHit = join(location, 'ComfyUI-资料')
    const registered = join(temp(), '任意安装目录', 'Stable')
    const outOfScope = join(temp(), '其他', '手动接入')
    for (const path of [clone, portable, forge, backup, falseHit, registered, outOfScope]) {
      await mkdir(join(path, 'models'), { recursive: true })
    }
    for (const path of [clone, portable, backup, outOfScope]) {
      await writeFile(join(path, 'main.py'), '')
      await writeFile(join(path, 'folder_paths.py'), '')
    }
    for (const path of [forge, registered]) {
      await writeFile(join(path, 'launch.py'), '')
      await writeFile(join(path, 'webui.py'), '')
    }
    await mkdir(join(forge, 'modules_forge'))
    const found = await findModelSources([location], [registered, portable], [])
    expect(found).toHaveLength(4)
    expect(found).toEqual(
      expect.arrayContaining([
        { path: registered, kind: 'webui' },
        { path: clone, kind: 'comfyui' },
        { path: join(location, '免安装'), kind: 'comfyui' },
        { path: join(location, '图像整合包'), kind: 'forge' },
      ]),
    )
    expect(await guessModelSourceKind(join(clone, 'models'))).toBe('comfyui')
    expect(await guessModelSourceKind(join(forge, 'models'))).toBe('forge')
    expect(await guessModelSourceKind(outOfScope)).toBe('comfyui')
  })

  it("still reads the extra config beside the install when ComfyUI's models folder is picked", async () => {
    const base = temp()
    const primary = join(base, 'models')
    const extras = join(base, '外部权重')
    await Promise.all([primary, extras].map((path) => mkdir(path)))
    await writeFile(join(base, 'extra_model_paths.yaml'), 'shared:\n  loras: 外部权重\n')
    expect(await guessModelSourceKind(primary)).toBe('comfyui')
    const result = await sourceRoots({ kind: 'comfyui', path: primary }, [])
    expect(result.roots).toEqual([primary, extras])
    expect(result.roles.get(extras)).toBe('lora')
  })

  it('reads the default and launch-argument folders of Forge and WebUI without running their scripts', async () => {
    const base = temp()
    const webui = join(base, 'webui')
    const models = join(webui, 'models')
    const checkpoint = join(base, '主模型文件')
    const loras = join(webui, '素材 库')
    const vae = join(webui, '附加组件')
    await Promise.all([models, checkpoint, loras, vae].map((path) => mkdir(path, { recursive: true })))
    await writeFile(
      join(webui, 'webui-user.bat'),
      '@echo off\nset "COMMANDLINE_ARGS=--ckpt-dir "' + checkpoint + '" --lora-dir="素材 库" --vae-dir "%~dp0附加组件""\n',
    )
    for (const kind of ['forge', 'webui'] as const) {
      const result = await sourceRoots({ kind, path: base }, [])
      expect(result.roots).toEqual([models, checkpoint, loras, vae])
      expect(result.roles.get(loras)).toBe('lora')
      expect(result.roles.get(checkpoint)).toBe('dit')
      expect(result.issues).toEqual([])
    }
  })

  it('combines the default folder, the extra config, relative paths and multi-line YAML values', async () => {
    const parent = temp()
    const base = join(parent, '便携版')
    const comfy = join(base, 'ComfyUI')
    const primary = join(comfy, 'models')
    const a = join(base, '共享模型', 'unet')
    const b = join(base, '共享模型', 'extra dit')
    await Promise.all([primary, a, b].map((path) => mkdir(path, { recursive: true })))
    await writeFile(
      join(comfy, 'extra_model_paths.yaml'),
      'studio:\n  base_path: ../共享模型\n  diffusion_models: |\n    unet\n    extra dit\n  custom_nodes: .\n',
    )
    const outcome = await sourceRoots({ kind: 'comfyui', path: base })
    expect(outcome.roots).toEqual([primary, a, b])
    expect(outcome.issues).toEqual([])
  })

  it('keeps the default models folder and reports a broken extra config', async () => {
    const primary = join(temp(), 'models')
    await mkdir(primary)
    await writeFile(join(temp(), 'extra_model_paths.yaml'), 'models: [')
    const result = await sourceRoots({ kind: 'comfyui', path: temp() })
    expect(result.roots).toEqual([primary])
    expect(result.issues).toEqual([expect.stringContaining('配置格式有误')])
    expect(result.issueDetails).toEqual([
      expect.objectContaining({
        message: '读不到配置文件，或配置格式有误',
        origin: join(temp(), 'extra_model_paths.yaml'),
        suggestion: expect.stringContaining('不影响读取默认 models 目录'),
      }),
    ])
  })

  it('silently skips missing extra_model_paths.yaml directories while recording their config origin and suggestion', async () => {
    const base = temp()
    const primary = join(base, 'models')
    const config = join(base, 'extra_model_paths.yaml')
    await mkdir(primary)
    await writeFile(
      config,
      'a1111:\n  base_path: ./不存在的webui\n  checkpoints: models/Stable-diffusion\n  vae: models/VAE\n  loras: |\n    models/Lora\n    models/LyCORIS\n',
    )
    const result = await sourceRoots({ kind: 'comfyui', path: primary }, [])
    expect(result.roots).toEqual([primary])
    expect(result.issueDetails).toHaveLength(1)
    expect(result.issueDetails[0]).toMatchObject({
      message: '已跳过配置中 4 个不存在的模型目录',
      origin: config,
      suggestion: expect.stringContaining('忽略'),
      details: [
        join(base, '不存在的webui', 'models', 'Stable-diffusion'),
        join(base, '不存在的webui', 'models', 'VAE'),
        join(base, '不存在的webui', 'models', 'Lora'),
        join(base, '不存在的webui', 'models', 'LyCORIS'),
      ],
    })
  })

  it('recognises a Comfy Desktop install and reads its user profile', async () => {
    const base = temp()
    const desktop = join(base, '下载', '自定义桌面安装')
    const profile = join(base, 'comfyui-desktop-2')
    const models = join(base, '模型库')
    await Promise.all([join(desktop, 'resources'), profile, models].map((path) => mkdir(path, { recursive: true })))
    await writeFile(join(desktop, 'Comfy Desktop.exe'), '')
    await writeFile(join(desktop, 'resources', 'app.asar'), '')
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ modelsDirs: [models] }))
    expect(await findModelSources([join(base, '下载')], [], [profile])).toEqual([{ kind: 'comfyui', path: desktop }])
    expect((await sourceRoots({ kind: 'comfyui', path: desktop }, [profile])).roots).toEqual([models])
  })

  it('reads the Comfy Desktop profile and the models folders of WebUI and Forge bundles', async () => {
    const base = temp()
    const managed = join(base, 'comfyui-desktop-2')
    const shared = join(base, '库')
    const models = join(base, 'webui', 'models')
    await Promise.all([managed, shared, models].map((path) => mkdir(path, { recursive: true })))
    await writeFile(join(managed, 'settings.json'), JSON.stringify({ modelsDirs: [shared] }))
    expect((await sourceRoots({ kind: 'comfyui', path: managed })).roots).toEqual([shared])
    expect((await sourceRoots({ kind: 'forge', path: base })).roots).toEqual([models])
    expect((await sourceRoots({ kind: 'webui', path: base })).roots).toEqual([models])
    expect(comfyModelPaths(join(base, 'extra.yaml'), 'one:\n  clip: ./库\n')).toEqual([shared])
  })
})

describe('shared model index', () => {
  const data = useTempDataRoot()

  it('reuses the cached suggestions after the first discovery; only 自动扫描 updates them and the running services', async () => {
    const settings = settingsFixture()
    const first = { path: join(temp(), '首个来源'), kind: 'comfyui' }
    const second = { path: join(temp(), '下一个来源'), kind: 'forge' }
    mocks.discover.mockReset()
    mocks.discover.mockResolvedValueOnce({ sources: [first] })
    mocks.discover.mockResolvedValueOnce({ sources: [first, second], services: [{ kind: 'comfyui', port: 8188 }] })
    expect((await modelSourcesView(settings)).suggestions).toMatchObject([first])
    expect((await modelSourcesView(settings)).suggestions).toMatchObject([first])
    expect(mocks.discover.mock.calls).toEqual([[false]])
    const fresh = await modelSourcesView(settings, 'scan')
    expect(fresh.suggestions).toMatchObject([first, second])
    expect(fresh.services).toEqual([{ kind: 'comfyui', port: 8188 }])
    const reopened = await modelSourcesView(settings)
    expect(reopened.suggestions).toMatchObject([first, second])
    expect(reopened.services).toBeUndefined()
    expect(mocks.discover.mock.calls).toEqual([[false], [true]])
    const cache = await readFile(join(data(), 'cache', 'model-source-discovery.json'), 'utf8')
    expect(JSON.parse(cache)).toEqual({ sources: [first, second] })
  })

  it('adds two installs of the same app, and moving one changes only that source', async () => {
    const roots = ['Comfy One', 'Comfy Two', 'Comfy Three'].map((name) => join(temp(), name))
    await Promise.all(roots.map((root) => mkdir(join(root, 'models'), { recursive: true })))
    const first = (await addModelSource(roots[0]!, 'comfyui')).modelSources![0]!
    const combined = (await addModelSource(roots[1]!, 'comfyui')).modelSources!
    expect(combined.map((source) => source.path)).toEqual(roots.slice(0, 2))
    expect(combined[1]!.id).not.toBe(first.id)
    const changed = (await addModelSource(roots[2]!, 'comfyui', first.id)).modelSources!
    expect(changed).toEqual([{ ...first, path: roots[2] }, combined[1]])
  })

  it('restores the saved inventory on restart; only a scan finds new files', async () => {
    const root = join(temp(), '共享')
    const server = join(temp(), 'moss-server')
    const old = join(root, 'old.safetensors')
    const added = join(root, 'added.safetensors')
    await mkdir(root)
    await writeFile(server, 'engine')
    await writeFile(old, 'weight')
    mocks.server = server
    mocks.inspect.mockClear()
    mocks.inspect.mockResolvedValue({ kind: 'dit', loadable: true })
    const settings = settingsFixture({
      modelsRoot: join(temp(), '内置'),
      modelSources: [{ id: 'source', kind: 'custom', path: root }],
    })
    await refreshModelSources(settings)
    await writeFile(added, 'new weight')
    expect(await restoreModelSources(settings)).toBe(false)
    expect(sharedModels().map((file) => file.name)).toEqual(['old.safetensors'])
    expect(mocks.inspect).toHaveBeenCalledTimes(1)
    await refreshModelSources(settings)
    expect(
      sharedModels()
        .map((file) => file.name)
        .sort(),
    ).toEqual(['added.safetensors', 'old.safetensors'])
    expect(mocks.inspect).toHaveBeenCalledTimes(2)
    mocks.inspect.mockClear()
  })

  it('accepts a complete diffusers folder with its runtime configs and resolves to the folder itself', async () => {
    const base = temp()
    const root = join(base, '完整模型')
    const paths = ['transformer', 'text_encoder', 'vae', 'scheduler', 'tokenizer']
    await Promise.all(paths.map((path) => mkdir(join(root, path), { recursive: true })))
    await writeFile(join(root, 'model_index.json'), JSON.stringify({ _class_name: 'MOSSImagePipeline' }))
    await writeFile(join(root, 'pipeline_moss_image.py'), 'configuration')
    await writeFile(join(root, 'scheduler', 'scheduler_config.json'), '{}')
    await writeFile(join(root, 'tokenizer', 'tokenizer_config.json'), '{}')
    await writeFile(join(root, 'tokenizer', 'tokenizer.json'), '{}')
    for (const part of paths.slice(0, 3)) {
      await writeFile(join(root, part, 'config.json'), '{}')
      await writeFile(join(root, part, 'model.safetensors'), 'fixture')
    }
    mocks.server = null
    const settings = settingsFixture({ modelsRoot: join(base, 'moss-studio'), modelSources: [{ id: 'full', kind: 'custom', path: root }] })
    await refreshModelSources(settings)
    const model = sharedModels()[0]!
    expect(model.role).toBe('full')
    expect(await resolveSharedWeight(model.id)).toBe(root)
  })
  it('keeps shared LoRA file names and tells available, pending and incompatible apart', async () => {
    const base = temp()
    const root = join(base, '应用')
    const folder = join(base, '自定义命名')
    const server = join(base, 'moss-server')
    await Promise.all([root, folder].map((path) => mkdir(path)))
    await writeFile(join(root, 'extra_model_paths.yaml'), 'shared:\n  loras: ../自定义命名\n')
    await writeFile(server, 'engine')
    for (const name of ['ready.safetensors', 'unavailable.safetensors', 'pending.safetensors']) {
      await writeFile(join(folder, name), 'weight')
    }
    mocks.server = server
    mocks.inspect.mockImplementation(async (_server: string, _method: string, { path }: { path: string }) => {
      if (path.endsWith('pending.safetensors')) throw new Error('engine busy')
      return { kind: 'lora', loadable: path.endsWith('ready.safetensors') }
    })
    const settings = settingsFixture({
      modelsRoot: join(base, 'moss-studio'),
      modelSources: [{ id: 'lora', kind: 'comfyui', path: root }],
    })
    await refreshModelSources(settings)
    const [status] = (await modelSourcesView(settings, 'connected')).sources
    expect(status).toMatchObject({ available: 1, pending: 1, incompatible: 1 })
    expect(status?.files).toEqual(
      expect.arrayContaining([
        { path: join(folder, 'ready.safetensors'), name: 'ready.safetensors', size: 6, role: 'lora', state: 'available' },
        { path: join(folder, 'pending.safetensors'), name: 'pending.safetensors', size: 6, role: 'lora', state: 'pending' },
        // B7: an incompatible file says why, in the words the import uses.
        {
          path: join(folder, 'unavailable.safetensors'),
          name: 'unavailable.safetensors',
          size: 6,
          role: 'lora',
          state: 'incompatible',
          reason: 'unavailable 不是给 MOSS-Image 用的，MossStudio 用不了它。',
        },
      ]),
    )
    expect(sharedAdapters().map(({ name }) => name)).toEqual(['ready.safetensors'])
    expect(status?.issues).toEqual([expect.stringContaining('engine busy')])
  })

  it('asks the engine about a GGUF main model instead of refusing its format', async () => {
    // B9: every .gguf file was listed as incompatible without asking the engine, which converts GGUF DiTs itself.
    const base = temp()
    const folder = join(base, 'models', 'diffusion_models')
    const server = join(base, 'moss-server')
    await mkdir(folder, { recursive: true })
    await writeFile(server, 'engine')
    await writeFile(join(folder, 'moss-image-sft-Q4_K_M.gguf'), 'gguf-weights')
    await writeFile(join(folder, 'moss-image-sft-Q3_K.gguf'), 'gguf-weights')
    mocks.server = server
    mocks.inspect.mockImplementation(async (_server: string, _method: string, { path }: { path: string }) =>
      path.includes('Q4_K_M')
        ? { kind: 'dit', loadable: true, precision: 'int8', quantization: 'GGUF Q4_K + Q6_K + BF16 + F32, runs as INT8 ConvRot' }
        : { kind: 'dit', loadable: false, note: 'GGUF tensors of types the engine does not read: Q3_K' },
    )
    const settings = settingsFixture({ modelsRoot: join(base, 'moss-studio'), modelSources: [{ id: 'gguf', kind: 'custom', path: base }] })
    await refreshModelSources(settings)
    const [status] = (await modelSourcesView(settings, 'connected')).sources
    expect(status).toMatchObject({ available: 1, incompatible: 1 })
    expect(sharedModels()).toEqual([expect.objectContaining({ name: 'moss-image-sft-Q4_K_M.gguf', role: 'dit', precision: 'int8' })])
    expect(status?.files.find((file) => file.state === 'incompatible')?.reason).toBe('这种压缩格式引擎读不了。')
  })

  it('uses weights where they are, lists each once, and keeps the same id after a folder comes back', async () => {
    const base = temp()
    const root = join(base, '用户目录')
    const sub = join(root, 'weights')
    const server = join(base, 'moss-server')
    await mkdir(sub, { recursive: true })
    await writeFile(server, 'engine')
    const weight = join(sub, '主模型.safetensors')
    await writeFile(weight, 'existing bytes')
    const lo = join(sub, 'lo.safetensors')
    const ctrl = join(sub, 'ctrl.safetensors')
    for (const file of [lo, ctrl]) await writeFile(file, 'existing bytes')
    await symlink(sub, join(root, 'linked'), 'junction')

    mocks.server = server
    mocks.inspect.mockImplementation(async (_server: string, _command: string, { path }: { path: string }) => ({
      kind: path === weight ? 'dit' : path === lo ? 'lora' : 'control_adapter',
      precision: 'int8',
      loadable: true,
      control_kinds: ['depth'],
    }))
    const settings = settingsFixture({
      modelsRoot: join(base, 'moss-studio'),
      modelSources: [
        { id: 'a', kind: 'custom', path: root },
        { id: 'b', kind: 'custom', path: sub },
      ],
    })
    await refreshModelSources(settings)
    expect(mocks.inspect).toHaveBeenCalledTimes(3)
    expect(await readFile(join(data(), 'cache', 'shared-models.json'), 'utf8')).toContain('mtimeMs')
    expect(sharedModels()).toHaveLength(1)
    expect(sharedAdapters()).toHaveLength(1)
    expect(sharedControlAdapters()).toHaveLength(1)
    const id = sharedModels()[0]!.id
    expect(await resolveSharedWeight(id)).toBe(weight)

    const moved = join(base, '临时拔掉')
    await rename(root, moved)
    expect(await resolveSharedWeight(id)).toBeNull()
    await refreshModelSources(settings)
    expect(sharedModels()).toEqual([])
    await rename(moved, root)
    await refreshModelSources(settings)
    expect(sharedModels()[0]!.id).toBe(id)
    expect(await readFile(weight, 'utf8')).toBe('existing bytes')
  })
})

describe('shared folder safety', () => {
  const secret = 'top-secret-token'
  afterEach(() => {
    delete process.env.MOSS_TEST_SECRET
  })

  it('expands only path variables in a config, so a planted config cannot put a secret into a path', async () => {
    process.env.MOSS_TEST_SECRET = secret
    const base = temp()
    await mkdir(join(base, 'models'))
    await writeFile(
      join(base, 'extra_model_paths.yaml'),
      'a:\n  base_path: ${MOSS_TEST_SECRET}\n  checkpoints: x\nb:\n  base_path: "%MOSS_TEST_SECRET%"\n  loras: y\n',
    )
    const result = await sourceRoots({ kind: 'comfyui', path: base }, [])
    expect(result.roots).toEqual([join(base, 'models')])
    expect(result.issues.length).toBeGreaterThan(0)
    expect(JSON.stringify([result.issues, result.issueDetails])).not.toContain(secret)
  })

  it('skips network places named by a config or a launch script, without echoing them', async () => {
    const base = join(temp(), 'forge')
    const comfyBase = join(temp(), 'comfy')
    const webui = join(base, 'webui')
    await mkdir(join(webui, 'models'), { recursive: true })
    await mkdir(comfyBase)
    await writeFile(
      join(comfyBase, 'extra_model_paths.yaml'),
      String.raw`a:
  base_path: //attacker@SSL/share
  checkpoints: x
b:
  loras: //host/loras
`,
    )
    await writeFile(join(webui, 'webui-user.sh'), 'export COMMANDLINE_ARGS="--ckpt-dir //attacker/weights"\n')
    const comfy = await sourceRoots({ kind: 'comfyui', path: comfyBase }, [])
    expect(comfy.roots).toEqual([])
    expect(comfy.issues).toEqual([expect.stringContaining('已跳过网络位置')])
    const forge = await sourceRoots({ kind: 'forge', path: base }, [])
    expect(forge.roots).toEqual([join(webui, 'models')])
    expect(forge.issues).toEqual([expect.stringContaining('已跳过网络位置')])
    expect(JSON.stringify([comfy.issues, comfy.issueDetails, forge.issues, forge.issueDetails])).not.toMatch(/attacker|host/)
  })

  it('skips the home folder or a filesystem root named by a config', async () => {
    const base = temp()
    await mkdir(join(base, 'models'))
    await writeFile(join(base, 'extra_model_paths.yaml'), `a:\n  base_path: "~"\n  checkpoints: .\n  loras: ${parse(base).root}\n`)
    const result = await sourceRoots({ kind: 'comfyui', path: base }, [])
    expect(result.roots).toEqual([join(base, 'models')])
    expect(result.issues).toEqual([expect.stringContaining('请选择具体的模型目录')])
  })

  it('parses a launch script with a 1 MB whitespace line in well under a second', async () => {
    const base = temp()
    const webui = join(base, 'webui')
    const loras = join(base, 'loras')
    await mkdir(join(webui, 'models'), { recursive: true })
    await mkdir(loras)
    await writeFile(
      join(webui, 'webui-user.sh'),
      // A value, a long run of spaces, then more text: the shape that made the old lazy-capture regex quadratic.
      'export COMMANDLINE_ARGS=x' +
        ' '.repeat(1_000_000) +
        'y\n' +
        'export' +
        ' '.repeat(4000) +
        'COMMANDLINE_ARGS=' +
        ' '.repeat(4000) +
        '--lora-dir "' +
        loras +
        '"\n',
    )
    const started = performance.now()
    const result = await sourceRoots({ kind: 'webui', path: base }, [])
    expect(performance.now() - started).toBeLessThan(1000)
    expect(result.roots).toEqual([join(webui, 'models'), loras])
  })
})

describe('shared model scan', () => {
  useTempDataRoot()
  // Settings are cached per module, so sources added by earlier tests would still be listed.
  beforeEach(() => {
    updateSettings({ modelSources: [] })
  })
  const engine = async (): Promise<string> => {
    const server = join(temp(), 'moss-server')
    await writeFile(server, 'engine')
    mocks.server = server
    return server
  }

  it('refuses the home folder, a filesystem root and an unpicked network place as a source', async () => {
    await expect(addModelSource(homedir())).rejects.toThrow('请选择具体的模型目录')
    await expect(addModelSource(parse(temp()).root)).rejects.toThrow('请选择具体的模型目录')
    await expect(addModelSource('//host/share/ComfyUI')).rejects.toThrow('网络位置')
  })

  it('scans a ComfyUI tree that holds a per-role download folder, leaving only that folder out', async () => {
    const base = temp()
    const tree = join(base, 'ComfyUI', 'models')
    const checkpoints = join(tree, 'checkpoints')
    await mkdir(checkpoints, { recursive: true })
    await mkdir(join(tree, 'vae'))
    await writeFile(join(checkpoints, 'downloaded.safetensors'), 'moss download')
    await writeFile(join(tree, 'vae', 'shared.safetensors'), 'shared weight')
    await engine()
    mocks.inspect.mockResolvedValue({ kind: 'vae', loadable: true })
    updateSettings({
      modelsRoot: join(base, 'moss'),
      modelDirectories: { ...settingsFixture().modelDirectories, dit: checkpoints },
    })
    await addModelSource(tree, 'custom')
    await refreshModelSources(getSettings())
    expect(sharedModels().map((model) => model.name)).toEqual(['shared.safetensors'])
    const [status] = (await modelSourcesView(getSettings(), 'connected')).sources
    expect(status?.issues).toContain('已跳过与 Moss Studio 下载位置重叠的目录')
    expect(status?.issueDetails).toEqual([
      expect.objectContaining({
        message: '已跳过与 Moss Studio 下载位置重叠的目录',
        origin: expect.stringContaining(checkpoints),
        suggestion: expect.stringContaining('设置 › 存储'),
      }),
    ])

    // Moving the per-role folder away (设置 › 存储) rescans the whole tree.
    updateSettings({ modelDirectories: { ...settingsFixture().modelDirectories, dit: null } })
    await refreshModelSources(getSettings(), true)
    expect(
      sharedModels()
        .map((model) => model.name)
        .sort(),
    ).toEqual(['downloaded.safetensors', 'shared.safetensors'])
  })

  it('keeps every shared weight after an engine update until the new engine has checked them again', async () => {
    const root = join(temp(), 'shared')
    await mkdir(root)
    await writeFile(join(root, 'dit.safetensors'), 'dit')
    await writeFile(join(root, 'style.safetensors'), 'lora')
    const server = await engine()
    mocks.inspect.mockImplementation(async (_server: string, _method: string, { path }: { path: string }) => ({
      kind: path.endsWith('dit.safetensors') ? 'dit' : 'lora',
      loadable: true,
    }))
    const settings = settingsFixture({ modelsRoot: join(temp(), 'moss'), modelSources: [{ id: 'one', kind: 'custom', path: root }] })
    await refreshModelSources(settings)

    // A restart after the engine was updated: the engine key (path and mtime) changed.
    const later = new Date((await stat(server)).mtimeMs + 60_000)
    await utimes(server, later, later)
    vi.resetModules()
    const restarted = await import('@main/services/modelSources')
    expect(restarted.sharedModels()).toEqual([])
    expect(await restarted.restoreModelSources(settings)).toBe(true)
    expect(restarted.sharedModels().map((model) => model.name)).toEqual(['dit.safetensors'])
    expect(restarted.sharedAdapters().map((adapter) => adapter.name)).toEqual(['style.safetensors'])

    mocks.inspect.mockClear()
    await restarted.refreshModelSources(settings)
    expect(mocks.inspect).toHaveBeenCalledTimes(2)
    expect(restarted.sharedAdapters().map((adapter) => adapter.name)).toEqual(['style.safetensors'])
  })

  it('restores the weights of the sources still configured when the sources changed while closed', async () => {
    const one = join(temp(), 'one')
    const two = join(temp(), 'two')
    await Promise.all([one, two].map((path) => mkdir(path)))
    await writeFile(join(one, 'a.safetensors'), 'a')
    await writeFile(join(two, 'b.safetensors'), 'b')
    await engine()
    mocks.inspect.mockResolvedValue({ kind: 'dit', loadable: true })
    const both = settingsFixture({
      modelsRoot: join(temp(), 'moss'),
      modelSources: [
        { id: 'one', kind: 'custom', path: one },
        { id: 'two', kind: 'custom', path: two },
      ],
    })
    await refreshModelSources(both)
    vi.resetModules()
    const restarted = await import('@main/services/modelSources')
    expect(await restarted.restoreModelSources({ ...both, modelSources: both.modelSources!.slice(0, 1) })).toBe(true)
    expect(restarted.sharedModels().map((model) => model.name)).toEqual(['a.safetensors'])
  })

  it('says why files stay pending when the engine cannot check them or is not installed', async () => {
    const root = join(temp(), 'shared')
    await mkdir(root)
    await writeFile(join(root, 'dit.safetensors'), 'dit')
    await engine()
    mocks.engineFailure = new Error('moss-server 请求超时：hello')
    const settings = settingsFixture({ modelsRoot: join(temp(), 'moss'), modelSources: [{ id: 'one', kind: 'custom', path: root }] })
    await refreshModelSources(settings)
    let [status] = (await modelSourcesView(settings, 'connected')).sources
    expect(status).toMatchObject({ pending: 1, available: 0 })
    expect(status?.issues).toEqual([expect.stringContaining('moss-server 请求超时：hello')])

    mocks.engineFailure = null
    mocks.server = null
    await refreshModelSources(settings)
    ;[status] = (await modelSourcesView(settings, 'connected')).sources
    expect(status?.issues).toEqual([expect.stringContaining('还没有安装引擎')])
  })

  it('tells a changed shared file from a missing one when a job asks for it', async () => {
    const root = join(temp(), 'shared')
    const file = join(root, 'dit.safetensors')
    await mkdir(root)
    await writeFile(file, 'dit')
    await engine()
    mocks.inspect.mockResolvedValue({ kind: 'dit', loadable: true })
    await refreshModelSources(
      settingsFixture({ modelsRoot: join(temp(), 'moss'), modelSources: [{ id: 'one', kind: 'custom', path: root }] }),
    )
    const [model] = sharedModels()
    expect(await requireSharedWeight(model!.id, model!.name)).toBe(file)
    await writeFile(file, 'retrained weights')
    await expect(requireSharedWeight(model!.id, model!.name)).rejects.toThrow(
      '「dit.safetensors」的文件改动过，请到「模型」页点「自动扫描」后再试',
    )
    await rename(file, join(root, 'moved.safetensors'))
    await expect(requireSharedWeight(model!.id, model!.name)).rejects.toThrow('找不到「dit.safetensors」的文件')
  })

  it('keeps a shared file in the catalog when the same file is also registered, and lists it once', async () => {
    const root = join(temp(), 'shared')
    const file = join(root, 'dit.safetensors')
    await mkdir(root)
    await writeFile(file, 'dit')
    await engine()
    mocks.inspect.mockResolvedValue({ kind: 'dit', loadable: true, precision: 'int8' })
    await refreshModelSources(
      settingsFixture({ modelsRoot: join(temp(), 'moss'), modelSources: [{ id: 'one', kind: 'custom', path: root }] }),
    )
    const [shared] = sharedModels()
    const registered = { ...shared!, id: 'local-scan-dit', tags: ['local-import', 'engine-checked'] }
    const models = [registered, shared!]
    expect(shared!.localPath).toBe(file)
    expect(duplicatesImportedFile(shared!, models)).toBe(true)
    expect(slotChoices(models, 'dit').map((choice) => choice.id)).toEqual(['local-scan-dit'])
    // One registered by its folder name alone is not offered, so the shared one is.
    expect(slotChoices([{ ...registered, tags: ['local-import'] }, shared!], 'dit').map((choice) => choice.id)).toEqual([shared!.id])
    // A combination saved with the shared id still finds its part.
    const components = { dit: shared!.id, textEncoder: 'qwen35-encoder', vae: 'flux2-vae-small' }
    expect(bundleWeightProblem({ components }, [...models, { id: 'qwen35-encoder' }, { id: 'flux2-vae-small' }])).toBeNull()
  })
})
