import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { mkdir, open, realpath, stat as pathStat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { isNetworkPath, pathLinksToNetwork } from '../lib/localPath'
import { z } from 'zod'
import { editChannel, type schemas, type ImageEditChannel } from '@shared/schemas'
import { agentPicturePath } from '../capabilities/agentPaths'
import { readJsonObject, writeJsonAtomic } from '../install/record'
import { codedError } from '../lib/codedError'
import { IMAGE_BYTES, publicImageUrl } from '../lib/imageEditHttp'
import { paths } from '../lib/paths'
import { hasAiKey, getAiKey, saveAiKeys } from './aiCredentials'
import { queryChannel } from './imageEditProtocols'
import { getProject, projectAssetsDir, projectsRootDir } from './projects'
import { getSettings } from './settings'
import { importImageBytes } from './studioAssets'

function enabled(agent = false) {
  const s = getSettings()
  if (s.externalImageEditEnabled !== true || (agent && s.externalAgentsEnabled !== true))
    throw codedError('E_FEATURE_OFF', '请先在设置中打开对应功能')
}
function records() {
  enabled()
  const file = paths.imageEditChannels()
  if (!existsSync(file)) return []
  try {
    readFileSync(file)
  } catch {
    // A lock or missing permission is not damage: moving the file aside would lose the channels.
    throw new Error('暂时无法读取重绘渠道，请稍后再试')
  }
  const channels = z.array(editChannel).safeParse(readJsonObject(file)?.channels)
  if (channels.success) return channels.data
  // Keep the damaged file for recovery and start empty, so channels can be added again in settings.
  try {
    renameSync(file, `${file}.broken-${Date.now()}`)
  } catch (error) {
    // Windows refuses to move a file another program holds open; settings must still open.
    console.warn('[image-edit] could not set the damaged channels file aside', error)
  }
  return []
}
const vault = paths.imageEditCredentials
// Bind ciphertext to its origin even if only one of the two atomic writes survives a crash.
const slot = (c: { id?: string; baseUrl: string }) => `${c.id}@${publicImageUrl(c.baseUrl).origin}`
export function listImageChannels(): ImageEditChannel[] {
  return records().map((c) => ({ ...c, hasKey: hasAiKey(slot(c), vault()) }))
}
export function saveImageChannel({ id, apiKey, ...fields }: z.infer<typeof schemas.imageEditChannelsSave>) {
  const rows = records(),
    old = rows.find((c) => c.id === id)
  if (id && !old) throw new Error('渠道已移除')
  const c = { ...fields, baseUrl: publicImageUrl(fields.baseUrl).href, id: id ?? randomUUID(), revision: randomUUID() }
  const changes: Record<string, string | null> = {}
  if (old && slot(old) !== slot(c)) {
    changes[slot(old)] = null
    changes[slot(c)] = null
  }
  if (apiKey !== undefined) changes[slot(c)] = apiKey
  if (Object.keys(changes).length) saveAiKeys(changes, vault())
  writeJsonAtomic(paths.imageEditChannels(), { channels: [c, ...rows.filter((r) => r.id !== id)] })
  return { ...c, hasKey: hasAiKey(slot(c), vault()) }
}
export function removeImageChannel(id: string) {
  const rows = records(),
    old = rows.find((c) => c.id === id)
  if (!old) return
  saveAiKeys({ [slot(old)]: null }, vault())
  writeJsonAtomic(paths.imageEditChannels(), { channels: rows.filter((c) => c.id !== id) })
}
const stamp = (s: import('node:fs').Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
export async function bindImageEdit(args: Record<string, unknown>) {
  enabled(true)
  const rows = listImageChannels(),
    c = args.channelId ? rows.find((r) => r.id === args.channelId) : rows[0]
  if (!c) throw new Error('请先在设置中添加重绘渠道')
  const sourceStamp = stamp(await pathStat(String(args.path)))
  return { ...args, sourceStamp, channelId: c.id, revision: c.revision, destination: `${publicImageUrl(c.baseUrl).origin} · ${c.model}` }
}
function connection(id: string, revision: string, agent = false) {
  const check = () => {
    enabled(agent)
    const c = listImageChannels().find((r) => r.id === id && r.revision === revision)
    if (!c) throw new Error('渠道已更改，请重新确认')
    return c
  }
  const c = check(),
    key = getAiKey(slot(c), vault())
  if (!key) throw new Error('请先为渠道设置 API Key')
  return { c, key, guard: check }
}
export async function discoverImageModels(draft: z.infer<typeof schemas.imageEditDiscoverModels>) {
  enabled()
  publicImageUrl(draft.baseUrl)
  const old = draft.id ? listImageChannels().find((r) => r.id === draft.id) : undefined
  const guard = () => {
    enabled()
    if (old && !listImageChannels().some((r) => r.id === old.id && r.revision === old.revision)) throw new Error('渠道已更改')
  }
  const key = draft.apiKey === undefined && old && slot(old) === slot(draft) ? getAiKey(slot(old), vault()) : draft.apiKey
  if (!key) throw new Error('请先输入该站点的 API Key')
  try {
    return await queryChannel({ ...draft, model: '' }, key, guard)
  } catch {
    throw new Error('无法探测模型，请检查渠道设置或手填模型名')
  }
}
// The 外接重绘 dialog names each run, so its 取消 can abort the request in flight.
const dialogRuns = new Map<string, AbortController>()
export async function runDialogImageEdit({ runId, ...input }: z.infer<typeof schemas.imageEditRun>) {
  const controller = new AbortController()
  if (runId) dialogRuns.set(runId, controller)
  try {
    return await runImageEdit(input, undefined, controller.signal)
  } finally {
    if (runId) dialogRuns.delete(runId)
  }
}
export function cancelImageEdit(runId: string) {
  enabled()
  dialogRuns.get(runId)?.abort(new Error('已取消重绘'))
}
export async function runImageEdit(
  input: z.infer<typeof schemas.imageEditRun>,
  approval?: { sourceStamp: string; signal?: AbortSignal },
  signal = approval?.signal,
) {
  const { c, key, guard } = connection(input.channelId, input.revision, !!approval)
  const checkProject = async () => {
    signal?.throwIfAborted()
    const dir = projectAssetsDir(input.projectId)
    const doc = join(dirname(dir), 'project.json')
    // The data root itself may be a link (MOSSSTUDIO_DATA, a Windows junction); nothing below it may be.
    const root = projectsRootDir(),
      realRoot = await realpath(root).catch(() => '')
    const unsafe = async (p: string) =>
      isNetworkPath(p) || (await pathLinksToNetwork(p)) || (await realpath(p).catch(() => '')) !== join(realRoot, relative(root, p))
    const moved = new Error('项目位置已改变，请重新打开项目')
    if ((await unsafe(doc)) || getProject(input.projectId)?.id !== input.projectId) throw moved
    // Like studioAssets, create assets/ on first use. Not recursive: that would follow an existing link to check it.
    await mkdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw new Error('无法创建项目的素材文件夹')
    })
    if (await unsafe(dir)) throw moved
  }
  await checkProject()
  const file = await open(await agentPicturePath(input.path), 'r')
  let bytes: Buffer
  try {
    const stat = await file.stat()
    if (approval && approval.sourceStamp !== stamp(stat)) throw new Error('图片已更改，请重新确认')
    if (!stat.isFile() || !stat.size || stat.size > IMAGE_BYTES) throw new Error('图片文件太大或不可读')
    bytes = Buffer.alloc(stat.size)
    let n = 0
    while (n < bytes.length) {
      const { bytesRead } = await file.read(bytes, n, bytes.length - n, n)
      if (!bytesRead) throw new Error('图片已更改')
      n += bytesRead
    }
    if (stamp(await pathStat(await agentPicturePath(input.path))) !== stamp(stat)) throw new Error('图片已更改')
  } finally {
    await file.close()
  }
  guard()
  const result = await queryChannel(c, key, guard, { bytes, prompt: input.prompt, signal }).catch(() => {
    signal?.throwIfAborted()
    throw new Error('重绘失败，请检查图片、渠道设置和返回格式')
  })
  if (!Buffer.isBuffer(result)) throw new Error('渠道未返回图片')
  await checkProject()
  guard()
  signal?.throwIfAborted()
  return importImageBytes(input.projectId, result, signal)
}
