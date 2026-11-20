import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isScannableWeights, scanModelDirectory } from '@main/services/modelScan'
import { useTempDir } from '@test/helpers/tempDir'

const tempDir = useTempDir('mossstudio-model-scan-')

async function fixture(files: Record<string, number>): Promise<string> {
  const root = tempDir()
  for (const [relativePath, size] of Object.entries(files)) {
    const target = join(root, relativePath)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, Buffer.alloc(size, 1))
  }
  return root
}

describe('scanModelDirectory', () => {
  it('a ComfyUI tree is recognised by its directory names', async () => {
    const root = await fixture({
      'diffusion_models/moss_image_sft_bf16.safetensors': 32,
      'text_encoders/qwen3.5_9b.safetensors': 16,
      'vae/flux2_vae_small.safetensors': 8,
      'loras/style.safetensors': 4,
    })
    const result = await scanModelDirectory(root)
    expect(result.files).toBe(4)
    const byName = new Map(result.candidates.map((candidate) => [candidate.name, candidate]))
    expect(byName.get('moss_image_sft_bf16.safetensors')?.role).toBe('dit')
    expect(byName.get('qwen3.5_9b.safetensors')?.role).toBe('text_encoder')
    expect(byName.get('flux2_vae_small.safetensors')?.role).toBe('vae')
    expect(byName.get('style.safetensors')?.role).toBe('lora')
    expect(result.candidates.every((candidate) => candidate.layout === 'comfyui-single-file')).toBe(true)
    expect(result.candidates.every((candidate) => candidate.confidence === 'high')).toBe(true)
    expect(result.skipped).toEqual([])
  })

  it('a diffusers folder is reported as one package and not walked into', async () => {
    const root = await fixture({
      'MOSS-Image-SFT/model_index.json': 2,
      'MOSS-Image-SFT/transformer/config.json': 2,
      'MOSS-Image-SFT/transformer/diffusion_pytorch_model.safetensors': 64,
    })
    const result = await scanModelDirectory(root)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      layout: 'diffusers-folder',
      role: 'full',
      relativePath: 'MOSS-Image-SFT',
      size: 0,
      confidence: 'high',
    })
    expect(result.files).toBe(0)
  })

  it('the picked folder itself can be a diffusers package', async () => {
    const root = await fixture({ 'model_index.json': 2, 'transformer/model.safetensors': 4 })
    const result = await scanModelDirectory(root)
    expect(result.candidates).toHaveLength(1)
    // Shown by its folder name, never ".".
    expect(result.candidates[0]!.relativePath).toBe(basename(root))
    expect(result.candidates[0]!.name).toBe(basename(root))
  })

  it('scanning never writes into the scanned directory', async () => {
    const root = await fixture({ 'diffusion_models/model.safetensors': 16 })
    const before = await readdir(root, { recursive: true })
    await scanModelDirectory(root)
    const after = await readdir(root, { recursive: true })
    expect(after.sort()).toEqual(before.sort())
  })

  it('unknown roles are marked low confidence instead of being dropped', async () => {
    const root = await fixture({ 'misc/weights.safetensors': 8 })
    const result = await scanModelDirectory(root)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.role).toBe('full')
    expect(result.candidates[0]!.confidence).toBe('low')
  })

  it('file names are a medium-confidence fallback when directories say nothing', async () => {
    const root = await fixture({
      'misc/moss_image_base.safetensors': 8,
      'misc/qwen3.5-encoder.safetensors': 8,
      'misc/my_vae.safetensors': 8,
      'misc/moss-pipeline.safetensors': 8,
    })
    const roles = Object.fromEntries((await scanModelDirectory(root)).candidates.map((c) => [c.name, [c.role, c.confidence]]))
    expect(roles).toEqual({
      'moss_image_base.safetensors': ['dit', 'medium'],
      'qwen3.5-encoder.safetensors': ['text_encoder', 'medium'],
      'my_vae.safetensors': ['vae', 'medium'],
      'moss-pipeline.safetensors': ['support', 'medium'],
    })
  })

  it('a directory hint beats a contradicting file name', async () => {
    const root = await fixture({ 'vae/moss_image_sft.safetensors': 8 })
    const [candidate] = (await scanModelDirectory(root)).candidates
    expect(candidate).toMatchObject({ role: 'vae', confidence: 'high', hint: '目录 vae' })
  })

  it('skips HF caches, ComfyUI side folders, hidden dirs, non-weights and empty files', async () => {
    const root = await fixture({
      'hf/hub/models--a--b/blobs/x.safetensors': 8,
      'snapshots/y.safetensors': 8,
      'controlnet/c.safetensors': 8,
      'embeddings/e.safetensors': 8,
      '.hidden/h.safetensors': 8,
      'custom_nodes/n.safetensors': 8,
      'vae/readme.txt': 8,
      'vae/empty.safetensors': 0,
      'vae/kept.safetensors': 8,
    })
    const result = await scanModelDirectory(root)
    expect(result.candidates.map((c) => c.relativePath)).toEqual([join('vae', 'kept.safetensors')])
    expect(result.files).toBe(1)
  })

  it('does not descend deeper than six levels', async () => {
    const root = await fixture({
      'a/b/c/d/e/f/ok.safetensors': 1,
      'a/b/c/d/e/f/g/too-deep.safetensors': 1,
    })
    expect((await scanModelDirectory(root)).candidates.map((c) => c.name)).toEqual(['ok.safetensors'])
  })

  it('sorts by role, then largest first', async () => {
    const root = await fixture({
      'vae/small.safetensors': 1,
      'vae/large.safetensors': 9,
      'diffusion_models/d.safetensors': 4,
    })
    expect((await scanModelDirectory(root)).candidates.map((c) => c.name)).toEqual([
      'd.safetensors',
      'large.safetensors',
      'small.safetensors',
    ])
  })

  it('a LoRA folder wins over a model folder around it, and Stable-diffusion is a model folder', async () => {
    const root = await fixture({
      'checkpoints/loras/style.safetensors': 4,
      'Stable-diffusion/model.safetensors': 8,
    })
    const roles = Object.fromEntries((await scanModelDirectory(root)).candidates.map((c) => [c.name, c.role]))
    expect(roles).toEqual({ 'style.safetensors': 'lora', 'model.safetensors': 'dit' })
  })

  it('a shared scan follows a linked folder outside the tree and names files by the link', async () => {
    const base = await fixture({ 'elsewhere/weights/big.safetensors': 8, 'tree/vae/v.safetensors': 4 })
    const outside = join(base, 'elsewhere')
    const root = join(base, 'tree')
    await symlink(join(outside, 'weights'), join(root, 'checkpoints'), 'junction')
    expect((await scanModelDirectory(root)).candidates.map((c) => c.name)).toEqual(['v.safetensors'])
    const shared = await scanModelDirectory(root, { shared: { exclude: [] } })
    const linked = shared.candidates.find((c) => c.name === 'big.safetensors')
    expect(linked).toMatchObject({
      path: join(outside, 'weights', 'big.safetensors'),
      relativePath: join('checkpoints', 'big.safetensors'),
      role: 'dit',
    })
  })

  it('a shared scan leaves out the excluded folders and visits a linked folder once', async () => {
    const root = await fixture({ 'downloads/mine.safetensors': 4, 'vae/v.safetensors': 4 })
    await symlink(join(root, 'vae'), join(root, 'again'), 'junction')
    const result = await scanModelDirectory(root, { shared: { exclude: [join(root, 'downloads')] } })
    expect(result.candidates.map((c) => c.name)).toEqual(['v.safetensors'])
  })

  it('stops after too many folders or too long, and says so', async () => {
    const root = await fixture({ 'a/1.safetensors': 1, 'b/2.safetensors': 1, 'c/3.safetensors': 1 })
    const capped = await scanModelDirectory(root, { maxDirectories: 2 })
    expect(capped.candidates.map((c) => c.name)).toEqual(['1.safetensors'])
    expect(capped.skipped).toEqual([{ path: join(root, 'b'), reason: '已检查 2 个文件夹，已停止扫描' }])
    const late = await scanModelDirectory(root, { timeLimitMs: -1 })
    expect(late.candidates).toEqual([])
    expect(late.skipped).toEqual([{ path: root, reason: '扫描超过 0 秒，已停止扫描' }])
  })

  it('rejects a file instead of a folder and a missing path', async () => {
    const root = await fixture({ 'a.safetensors': 1 })
    await expect(scanModelDirectory(join(root, 'a.safetensors'))).rejects.toThrow('请选择模型文件夹')
    await expect(scanModelDirectory(join(root, 'missing'))).rejects.toThrow()
  })
})

describe('isScannableWeights', () => {
  it('accepts weight extensions case-insensitively and rejects .onnx and others', () => {
    for (const ext of ['.safetensors', '.CKPT', '.pt', '.pth', '.bin', '.gguf']) expect(isScannableWeights(ext)).toBe(true)
    for (const ext of ['.onnx', '.json', '', 'safetensors']) expect(isScannableWeights(ext)).toBe(false)
  })
})
