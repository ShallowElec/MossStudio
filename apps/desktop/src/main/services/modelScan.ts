import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import type { ModelScanResult, ScannedModel } from '@shared/types'
import { isNetworkPath, linksToNetwork, modelPathKey } from '../lib/localPath'
import { isInside } from '../lib/paths'
import { diffusersFolderName, inspectDiffusersFolder, type ImportedModelRole } from './modelImports'

/**
 * Read-only discovery of model files a user already has on disk.
 *
 * Nothing here writes, hashes or copies: pointing MossStudio at an existing
 * ComfyUI tree must not create folders in it, and hashing 27 GB before showing
 * anything is unusable. Registration happens in a second, explicit step; hashes
 * are computed later, only when a file is actually used or the user asks for one.
 */
export type ScanResult = ModelScanResult

const modelExtensions = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx'])
const weightsExtension = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf'])
const skippedDirectories = new Set([
  '.git',
  '.cache',
  '.clover',
  'blobs',
  'snapshots',
  'refs',
  'hf',
  'node_modules',
  'venv',
  '.venv',
  '__pycache__',
  'input',
  'output',
  'temp',
  'custom_nodes',
  'user',
  'logs',
  'sessions',
  'clip_vision',
  'controlnet',
  'embeddings',
  'upscale_models',
  'style_models',
  'gligen',
  'hypernetworks',
  'photomaker',
  'vae_approx',
  'diffusers',
])

const maxDepth = 6
const maxFiles = 4000
/** Bound a scan of a folder far larger than a models tree (a whole drive reached through a link). */
export const MAX_SCAN_DIRECTORIES = 5000
export const SCAN_TIME_LIMIT_MS = 30_000

interface RoleRule {
  role: ImportedModelRole
  /** Directory names ComfyUI and diffusers layouts use for this role. */
  directories: RegExp[]
  /** Cheap file-name hints, used when the directory does not give the role. */
  names: RegExp[]
}

const rules: RoleRule[] = [
  {
    role: 'dit',
    directories: [/^diffusion[_-]?models?$/, /^stable[-_]diffusion$/, /^unet$/, /^checkpoints?$/, /^transformer$/],
    names: [/moss[_-]?image/, /moss[_-]?(sft|base)/, /diffusion[_-]?model/],
  },
  {
    role: 'text_encoder',
    directories: [/^text[_-]?encoders?$/, /^clip$/, /^text_encoder$/],
    names: [/qwen3?\.?5/, /text[_-]?encoder/, /^clip/],
  },
  {
    role: 'vae',
    directories: [/^vaes?$/, /^vae$/],
    names: [/vae/, /flux2[_-]?vae/],
  },
  {
    role: 'support',
    directories: [/^support$/, /^scheduler$/, /^pipeline$/, /^configs?$/],
    names: [/moss[_-]?pipeline/, /scheduler/, /runtime[_-]?config/],
  },
]

function segments(relativePath: string): string[] {
  return relativePath
    .split(/[\\/]/)
    .slice(0, -1)
    .map((part) => part.toLowerCase())
}

/** A directory name wins over a file name; the file name is a weaker signal. */
function detectRole(relativePath: string): { role: ImportedModelRole | 'lora'; confidence: ScannedModel['confidence']; hint: string } {
  const directories = segments(relativePath)
  if (directories.some((part) => /^(loras?|lycoris)$/.test(part))) {
    return { role: 'lora', confidence: 'high', hint: '目录 loras' }
  }
  for (const rule of rules) {
    for (const pattern of rule.directories) {
      const hit = directories.find((part) => pattern.test(part))
      if (hit) return { role: rule.role, confidence: 'high', hint: `目录 ${hit}` }
    }
  }
  const name = basename(relativePath).toLowerCase()
  for (const rule of rules) {
    const pattern = rule.names.find((candidate) => candidate.test(name))
    if (pattern) return { role: rule.role, confidence: 'medium', hint: `文件名 ${name}` }
  }
  return { role: 'full', confidence: 'low', hint: '未识别角色，需要手动指定' }
}

function isDiffusersFolder(entries: string[]): boolean {
  const lower = entries.map((name) => name.toLowerCase())
  return lower.includes('model_index.json') || lower.includes('transformer/config.json')
}

export interface ScanOptions {
  /** A shared-folder scan: follows folder links to local targets and reads the diffusers and controlnet folders. */
  shared?: {
    /** Folders not to enter: Moss Studio's own download folders inside a shared tree. */
    exclude: string[]
  }
  maxDirectories?: number
  timeLimitMs?: number
}

interface Walk {
  root: string
  result: ScanResult
  shared: ScanOptions['shared'] | null
  visited: Set<string>
  directories: number
  maxDirectories: number
  deadline: number
  timeLimitMs: number
  stopped: boolean
}

function stop(walk: Walk, path: string, reason: string): void {
  walk.stopped = true
  walk.result.skipped.push({ path, reason })
}

/** `logical` is the folder as reached through links; it gives roles and relative paths, `directory` the real files. */
async function walkDirectory(walk: Walk, directory: string, logical: string, depth: number): Promise<void> {
  const { root, result } = walk
  if (walk.stopped || depth > maxDepth || walk.visited.has(modelPathKey(directory))) return
  if (++walk.directories > walk.maxDirectories) return stop(walk, directory, `已检查 ${walk.maxDirectories} 个文件夹，已停止扫描`)
  if (Date.now() > walk.deadline) return stop(walk, directory, `扫描超过 ${Math.round(walk.timeLimitMs / 1000)} 秒，已停止扫描`)
  walk.visited.add(modelPathKey(directory))
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    result.skipped.push({
      path: directory,
      reason: error instanceof Error ? error.message : String(error),
    })
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  if (isDiffusersFolder(entries.map((entry) => entry.name))) {
    // The picked folder itself: show its name, not ".".
    const relativePath = relative(root, logical) || basename(logical)
    const info = await stat(directory).catch(() => null)
    const folder = await inspectDiffusersFolder(directory)
    if (info) {
      result.candidates.push({
        path: directory,
        relativePath,
        name: diffusersFolderName(directory, folder?.flavor ?? null),
        size: folder?.size ?? 0,
        mtimeMs: folder?.mtimeMs ?? info.mtimeMs,
        role: 'full',
        layout: 'diffusers-folder',
        confidence: 'high',
        hint: 'diffusers 文件夹',
      })
    }
    return
  }
  for (const entry of entries) {
    if (walk.stopped) return
    let absolute = join(directory, entry.name)
    let linked: Awaited<ReturnType<typeof stat>> | null = null
    if (walk.shared && entry.isSymbolicLink()) {
      // ComfyUI setups often link checkpoints to another drive; follow it unless it leads to the network.
      const network = await linksToNetwork(absolute)
      const target = network ? null : await realpath(absolute).catch(() => null)
      if (network || (target && isNetworkPath(target)))
        result.skipped.push({ path: absolute, reason: '已跳过网络位置（文件夹链接指向网络）' })
      if (!target || isNetworkPath(target)) continue
      absolute = target
      linked = await stat(target).catch(() => null)
    }
    if (entry.isDirectory() || linked?.isDirectory()) {
      const lower = entry.name.toLowerCase()
      if (entry.name.startsWith('.') || (skippedDirectories.has(lower) && !(walk.shared && ['diffusers', 'controlnet'].includes(lower))))
        continue
      if (walk.shared?.exclude.some((folder) => isInside(folder, absolute))) continue
      await walkDirectory(walk, absolute, join(logical, entry.name), depth + 1)
      continue
    }
    if (!entry.isFile() && !linked?.isFile()) continue
    const extension = extname(entry.name).toLowerCase()
    if (!modelExtensions.has(extension)) continue
    if (result.files >= maxFiles) return stop(walk, directory, `文件超过 ${maxFiles} 个，已停止扫描`)
    const info = await stat(absolute).catch(() => null)
    if (!info || !info.isFile() || info.size <= 0) continue
    result.files += 1
    const relativePath = relative(root, join(logical, entry.name))
    // A shared root is itself named by role (checkpoints, loras), so its own name counts.
    const detected = detectRole(walk.shared ? join(basename(root), relativePath) : relativePath)
    result.candidates.push({
      path: absolute,
      relativePath,
      name: entry.name,
      size: info.size,
      mtimeMs: info.mtimeMs,
      role: detected.role,
      layout: 'comfyui-single-file',
      confidence: detected.confidence,
      hint: detected.hint,
    })
  }
}

export async function scanModelDirectory(directory: string, options: ScanOptions = {}): Promise<ScanResult> {
  const root = await realpath(resolve(directory))
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('请选择模型文件夹')
  const result: ScanResult = {
    root,
    scannedAt: new Date().toISOString(),
    files: 0,
    candidates: [],
    skipped: [],
  }
  const timeLimitMs = options.timeLimitMs ?? SCAN_TIME_LIMIT_MS
  const walk: Walk = {
    root,
    result,
    shared: options.shared ?? null,
    visited: new Set(),
    directories: 0,
    maxDirectories: options.maxDirectories ?? MAX_SCAN_DIRECTORIES,
    deadline: Date.now() + timeLimitMs,
    timeLimitMs,
    stopped: false,
  }
  await walkDirectory(walk, root, root, 0)
  result.candidates.sort((a, b) => {
    if (a.role !== b.role) return a.role.localeCompare(b.role)
    return b.size - a.size
  })
  return result
}

export function isScannableWeights(extension: string): boolean {
  return weightsExtension.has(extension.toLowerCase())
}
