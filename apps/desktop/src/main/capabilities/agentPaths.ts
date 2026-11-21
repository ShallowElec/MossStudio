import { realpath } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ActionDescriptor } from '@shared/capabilities'
import { codedError } from '../lib/codedError'
import { isNetworkPath, pathLinksToNetwork } from '../lib/localPath'
import { isInside } from '../lib/paths'
import { galleryRoots } from '../services/gallery'
import { projectsRootDir } from '../services/projects'

/** Picture files an Agent may name. */
const AGENT_PICTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

/** The arguments of each action that name a file on this computer. */
export const AGENT_PATH_ARGS: Readonly<Record<string, 'path' | 'files'>> = {
  'studio.projects.import_image': 'path',
  'studio.gbc.parse_image': 'path',
  'studio.gbc.start_job': 'files',
  'library.assets.get': 'path',
  'library.assets.read_image': 'path',
  'library.assets.trash': 'path',
}

/**
 * The real path of a picture an external Agent named, when it is a local file
 * inside 作品 (the gallery folders) or a project's folder. A network path, or a
 * link to one, is refused without being opened: on Windows opening it would
 * authenticate with the person's NTLM hash (lib/localPath.ts).
 */
export async function agentPicturePath(path: string): Promise<string> {
  if (isNetworkPath(path) || (await pathLinksToNetwork(path))) throw codedError('E_AGENT_PATH', '不能读取网络位置上的文件')
  const real = await realpath(path).catch(() => null)
  if (!real) throw codedError('E_AGENT_PATH', `找不到这个文件：${path}`)
  if (isNetworkPath(real)) throw codedError('E_AGENT_PATH', '不能读取网络位置上的文件')
  if (!AGENT_PICTURE_EXT.has(extname(real).toLowerCase())) throw codedError('E_AGENT_PATH', '只能使用 PNG、JPEG、WebP 或 BMP 图片')
  const roots = await Promise.all([...(await galleryRoots()), projectsRootDir()].map((root) => realpath(root).catch(() => null)))
  if (!roots.some((root) => root && isInside(root, real))) throw codedError('E_AGENT_PATH', '只能使用作品库或项目里的图片')
  return real
}

/** Arguments of a capability call with every file it names checked and replaced by its real path. */
export async function prepareAgentPaths(action: ActionDescriptor, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = AGENT_PATH_ARGS[action.id]
  if (!key) return args
  const value = args[key]
  if (key === 'files') {
    const files = Array.isArray(value) ? value.map(String) : []
    return { ...args, files: await Promise.all(files.map(agentPicturePath)) }
  }
  return typeof value === 'string' ? { ...args, path: await agentPicturePath(value) } : args
}
