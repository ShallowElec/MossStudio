import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ModelSource, ModelSourceIssue, ModelSourceKind, ScannedModel } from '@shared/types'
import { expandPathVariables, isNetworkPath, linksToNetwork, modelPathKey } from '../lib/localPath'
import { isInside } from '../lib/paths'
import { windowsModelLocations } from './modelSourceDiscovery'
import { probeLocalModelServices } from './modelSourceServices'

type SourceLocation = Pick<ModelSource, 'kind' | 'path'>
/** `network` marks a value that named a network place before path functions could normalise it away. */
type ModelRoot = { path: string; role?: ScannedModel['role']; network?: boolean; origin?: string }
type DesktopProfile = {
  path: string
  roots: ModelRoot[]
  aliases: string[]
  configs: string[]
  issues: string[]
  issueDetails: ModelSourceIssue[]
}

const modelRoles: Partial<Record<string, ModelRoot['role']>> = {
  checkpoints: 'dit',
  diffusion_models: 'dit',
  unet: 'dit',
  text_encoders: 'text_encoder',
  text_encoder: 'text_encoder',
  clip: 'text_encoder',
  vae: 'vae',
  loras: 'lora',
  lora: 'lora',
  lycoris: 'lora',
  diffusers: 'full',
  controlnet: 'full',
}
const configNames = ['extra_model_paths.yaml', 'extra_models_config.yaml']
const packageName = /comfyui|comfy[-_ ]desktop|forge|webui|stable[-_ ]diffusion|portable|bundle|整合|便携/i
const backupName = /(?:^|[\\/._ -])(?:backup\d*|backups|bak|old|archive|copy)(?:$|[\\/._ -])|备份|副本/i
/** Launch scripts are short; a longer line is not a setting worth parsing on the main thread. */
const MAX_SCRIPT_LINE = 8192
/** Ports ComfyUI and SD WebUI / Forge listen on by default; 自动扫描 asks only these, on loopback. */
const DEFAULT_SERVICE_PORTS = [8188, 7860]

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

async function readConfig(file: string): Promise<string> {
  const info = await stat(file)
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('配置文件不可读或太大')
  return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '')
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false
}

/** A filesystem root or the home folder itself: scanning it would walk the whole disk or profile. */
export function isTooBroadModelFolder(path: string): boolean {
  const full = resolve(path)
  return full === parse(full).root || modelPathKey(full) === modelPathKey(resolve(homedir()))
}

/** A directory that a config file named, checked only when it is a local path. */
async function isLocalDirectory(path: string, network = isNetworkPath(path)): Promise<boolean> {
  return !network && (await isDirectory(path))
}

function comfyRoots(file: string, yaml: string): ModelRoot[] {
  const result: ModelRoot[] = []
  for (const section of Object.values(record(parseYaml(yaml, { maxAliasCount: 20 })))) {
    const config = record(section)
    const basePath = typeof config.base_path === 'string' ? expandPathVariables(config.base_path) : null
    const base = basePath === null ? dirname(file) : resolve(dirname(file), basePath)
    for (const [key, value] of Object.entries(config)) {
      if (!Object.hasOwn(modelRoles, key) || typeof value !== 'string') continue
      for (const line of value.split(/\r?\n/)) {
        const entry = line.trim()
        if (!entry) continue
        const network = (basePath !== null && isNetworkPath(basePath)) || isNetworkPath(entry)
        result.push({ path: resolve(base, entry), role: modelRoles[key], network, origin: file })
      }
    }
  }
  return result
}

export function comfyModelPaths(file: string, yaml: string): string[] {
  return comfyRoots(file, yaml).map(({ path }) => path)
}

function desktopProfileLocations(): string[] {
  const home = homedir()
  const config =
    process.platform === 'win32'
      ? process.env.APPDATA
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'))
  return config ? ['ComfyUI', 'comfyui-desktop-2'].map((name) => join(config, name)) : []
}

async function readDesktopProfile(path: string): Promise<DesktopProfile> {
  const profile: DesktopProfile = { path, roots: [], aliases: [], configs: [], issues: [], issueDetails: [] }
  for (const name of ['config.json', 'settings.json']) {
    const file = join(path, name)
    if (!(await isFile(file))) continue
    try {
      const settings = record(JSON.parse(await readConfig(file)))
      if (Array.isArray(settings.modelsDirs)) {
        for (const value of settings.modelsDirs) {
          if (typeof value === 'string' && isAbsolute(value)) {
            profile.roots.push({ path: value, network: isNetworkPath(value), origin: file })
          }
        }
      }
      if (typeof settings.basePath === 'string' && isAbsolute(settings.basePath)) {
        profile.aliases.push(settings.basePath)
        if (await isLocalDirectory(join(settings.basePath, 'models'), isNetworkPath(settings.basePath))) {
          profile.roots.push({ path: join(settings.basePath, 'models'), origin: file })
        }
      }
      if (typeof settings.installDir === 'string' && isAbsolute(settings.installDir)) profile.aliases.push(settings.installDir)
    } catch {
      profile.issues.push('读不到配置文件，或配置格式有误：' + file)
      profile.issueDetails.push({
        id: 'bad-config:' + modelPathKey(file),
        message: '读不到配置文件，或配置格式有误',
        origin: file,
        suggestion: '请检查该配置文件的格式和读取权限；已自动跳过该配置，不影响读取默认 models 目录。',
      })
    }
  }
  for (const name of configNames) {
    const file = join(path, name)
    if (await isFile(file)) profile.configs.push(file)
  }
  return profile
}

async function runtimeLocations(path: string): Promise<string[]> {
  const standard = [path, join(path, 'ComfyUI'), join(path, 'resources', 'ComfyUI'), join(path, 'webui')]
  if (!packageName.test(basename(path))) return standard
  // Some bundles keep the sources in a versioned folder; only this one level is checked.
  const extras = (await readdir(path, { withFileTypes: true }).catch(() => []))
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && packageName.test(entry.name) && !backupName.test(entry.name))
    .map((entry) => join(path, entry.name))
  return [...new Map([...standard, ...extras].map((entry) => [modelPathKey(entry), entry])).values()]
}

async function desktopProfileName(path: string): Promise<string | undefined> {
  const asar = join(path, 'resources', 'app.asar')
  if ((await isFile(join(path, 'Comfy Desktop.exe'))) && (await isFile(asar))) return 'comfyui-desktop-2'
  if ((await isFile(join(path, 'ComfyUI.exe'))) && ((await isFile(asar)) || (await isDirectory(join(path, 'resources', 'ComfyUI'))))) {
    return 'ComfyUI'
  }
  return undefined
}

async function runtimeKind(path: string): Promise<ModelSourceKind | undefined> {
  if ((await isFile(join(path, 'main.py'))) && (await isFile(join(path, 'folder_paths.py')))) return 'comfyui'
  if ((await isFile(join(path, 'launch.py'))) && (await isFile(join(path, 'webui.py')))) {
    return (await isDirectory(join(path, 'modules_forge'))) ? 'forge' : 'webui'
  }
  return (await desktopProfileName(path)) ? 'comfyui' : undefined
}

/** The app installed at this folder (ComfyUI, Stable Diffusion WebUI or Forge), read from its files; undefined for any other folder. */
export async function installationKind(path: string): Promise<ModelSourceKind | undefined> {
  const kinds = await Promise.all((await runtimeLocations(path)).map(runtimeKind))
  return kinds.find((kind) => kind !== undefined)
}

function webuiArguments(launchScript: string): Map<string, string> {
  const flags = new Map<string, string>()
  for (const raw of launchScript.replace(/[\\^]\r?\n/g, ' ').split(/\r?\n/)) {
    if (raw.length > MAX_SCRIPT_LINE) continue
    // trim() and an anchored prefix keep this linear: the old single regex backtracked quadratically on long whitespace.
    const line = raw.trim()
    const prefix = /^@?(?:(?:set|export)\s+)?"?COMMANDLINE_ARGS/i.exec(line)
    if (!prefix) continue
    const assignment = line.slice(prefix[0].length).trimStart()
    if (!assignment.startsWith('=')) continue
    // Drop the quotes around the whole setting and keep each path's own quotes.
    let args = assignment.slice(1).trim()
    const quote = args[0]
    if ((quote === '"' || quote === "'") && args.endsWith(quote)) args = args.slice(1, -1)
    else if (/^@?set\s+"/i.test(line) && args.endsWith('"')) args = args.slice(0, -1)
    // Unknown flags consume their value too, so words in a prompt argument are never read as a path flag.
    const tokens = [...args.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)].map(([token]) => token.replace(/(['"])(.*?)\1/g, '$2'))
    for (let i = 0; i < tokens.length; i++) {
      const flag = tokens[i]!.match(/^--([\w-]+)(?:=(.*))?$/)
      if (!flag) continue
      const value = flag[2] || tokens[i + 1]
      if (!value || value.startsWith('--')) continue
      flags.set(flag[1]!, value)
      if (!flag[2]) i++
    }
  }
  return flags
}

const webuiModelOptions = [
  { flag: 'ckpt-dir', folder: 'Stable-diffusion', role: 'dit' },
  { flag: 'lora-dir', folder: 'Lora', role: 'lora' },
  { flag: 'lyco-dir', folder: 'LyCORIS', role: 'lora' },
  { flag: 'vae-dir', folder: 'VAE', role: 'vae' },
  { flag: 'text-encoder-dir', folder: 'text_encoder', role: 'text_encoder' },
  { flag: 'unet-dir', folder: 'UNet', role: 'dit' },
  { flag: 'controlnet-dir', folder: 'ControlNet', role: 'full' },
] as const

async function webuiRoots(base: string, kind: 'webui' | 'forge', issues: string[], issueDetails: ModelSourceIssue[]): Promise<ModelRoot[]> {
  const roots: ModelRoot[] = []
  const scripts = ['webui-user.bat', 'webui-user.sh']
  if (process.platform !== 'win32') scripts.reverse()
  const args = new Map<string, { value: string; file: string }>()
  for (const name of scripts) {
    const file = join(base, name)
    if (!(await isFile(file))) continue
    try {
      for (const [key, value] of webuiArguments(await readConfig(file))) args.set(key, { value, file })
    } catch {
      issues.push('读不到启动配置：' + file)
      issueDetails.push({
        id: 'bad-script:' + modelPathKey(file),
        message: '读不到启动配置',
        origin: file,
        suggestion: '请检查该启动脚本的读取权限；已自动跳过该配置，不影响读取默认 models 目录。',
      })
    }
  }
  const pathFor = (flag: string): ModelRoot | undefined => {
    const entry = args.get(flag)
    if (!entry) return undefined
    const path = expandPathVariables(entry.value.replace(/%~dp0/gi, base + sep).replace(/%CD%/gi, base))
    // A variable left unexpanded is not on the allowlist; the setting is dropped rather than guessed.
    return /%[^%]+%|\$\{|\$\w/.test(path) ? undefined : { path: resolve(base, path), network: isNetworkPath(path), origin: entry.file }
  }
  const data = pathFor('data-dir')
  if (data && (await isLocalDirectory(join(data.path, 'models'), data.network))) {
    roots.push({ path: join(data.path, 'models'), origin: data.origin })
  }
  const models = pathFor('models-dir')
  if (models) roots.push(models)
  const reference = kind === 'forge' ? pathFor('forge-ref-a1111-home') : undefined
  for (const { flag, folder, role } of webuiModelOptions) {
    const explicit = pathFor(flag)
    const referenced = reference && join(reference.path, 'models', folder)
    if (explicit) roots.push({ ...explicit, role })
    else if (referenced && (await isLocalDirectory(referenced, reference.network))) {
      roots.push({ path: referenced, role, origin: reference.origin })
    }
  }
  return roots
}

export async function sourceRoots(
  source: SourceLocation,
  profileLocations = desktopProfileLocations(),
): Promise<{ roots: string[]; roles: Map<string, ScannedModel['role']>; issues: string[]; issueDetails: ModelSourceIssue[] }> {
  const roots: ModelRoot[] = []
  const issues: string[] = []
  const issueDetails: ModelSourceIssue[] = []
  const roles = new Map<string, ScannedModel['role']>()
  const addDetail = (detail: ModelSourceIssue): void => {
    if (!issueDetails.some((item) => item.id === detail.id)) issueDetails.push(detail)
  }
  const info = await stat(source.path).catch(() => null)
  if (!info) {
    return {
      roots: [],
      roles,
      issues: ['找不到此位置，请检查磁盘连接或更换路径'],
      issueDetails: [
        {
          id: 'missing-source:' + modelPathKey(source.path),
          message: '找不到此位置',
          origin: source.path,
          suggestion: '请检查磁盘连接或路径是否已移动，也可以点击「更换路径」重新选择。',
        },
      ],
    }
  }
  const configs = new Set<string>()
  if (info.isFile() && source.kind === 'comfyui') {
    configs.add(source.path)
  } else if (info.isDirectory() && source.kind === 'custom') {
    roots.push({ path: source.path })
  } else if (info.isDirectory()) {
    const modelsSelected = /^models$/i.test(basename(source.path))
    const install = modelsSelected ? dirname(source.path) : source.path
    if (modelsSelected) roots.push({ path: source.path })
    const kind = source.kind
    const bases = await runtimeLocations(install)
    for (const base of bases) {
      const models = join(base, 'models')
      if (await isDirectory(models)) roots.push({ path: models })
      if (kind === 'comfyui') {
        for (const name of configNames) {
          const file = join(base, name)
          if (await isFile(file)) configs.add(file)
        }
      } else if (kind === 'webui' || kind === 'forge') {
        roots.push(...(await webuiRoots(base, kind, issues, issueDetails)))
      }
    }
    if (kind === 'comfyui') {
      const desktop = await desktopProfileName(install)
      const profiles = await Promise.all([...new Set([install, ...profileLocations])].map(readDesktopProfile))
      const key = modelPathKey(install)
      for (const profile of profiles) {
        const linked = profile.aliases.some((path) => modelPathKey(resolve(path)) === key)
        if (modelPathKey(profile.path) !== key && !linked && basename(profile.path).toLowerCase() !== desktop?.toLowerCase()) continue
        roots.push(...profile.roots)
        profile.configs.forEach((file) => configs.add(file))
        issues.push(...profile.issues)
        profile.issueDetails.forEach(addDetail)
      }
    }
    if (!roots.length && !configs.size && !issues.length && !(await installationKind(install))) roots.push({ path: source.path })
  } else {
    issues.push('请选择共享模型目录')
    addDetail({
      id: 'invalid-source:' + modelPathKey(source.path),
      message: '请选择共享模型目录',
      origin: source.path,
      suggestion: '请选择文件夹或 ComfyUI 的 extra_model_paths.yaml 配置文件。',
    })
  }

  for (const file of configs) {
    try {
      if (/\.json$/i.test(file)) {
        // A Comfy Desktop config.json saved as a source by an earlier build.
        const config = record(JSON.parse(await readConfig(file)))
        if (Array.isArray(config.modelsDirs)) {
          for (const path of config.modelsDirs) {
            if (typeof path === 'string' && isAbsolute(path)) roots.push({ path, network: isNetworkPath(path), origin: file })
          }
        }
        if (typeof config.basePath === 'string' && isAbsolute(config.basePath)) {
          roots.push({ path: join(config.basePath, 'models'), network: isNetworkPath(config.basePath), origin: file })
        }
      } else roots.push(...comfyRoots(file, await readConfig(file)))
    } catch {
      issues.push('读不到配置文件，或配置格式有误：' + file)
      addDetail({
        id: 'bad-config:' + modelPathKey(file),
        message: '读不到配置文件，或配置格式有误',
        origin: file,
        suggestion: '请检查该配置文件的格式和读取权限；已自动跳过该配置，不影响读取默认 models 目录。',
      })
    }
  }

  const unique = new Map<string, string>()
  const resolved = new Map<string, string | null>()
  const missingByOrigin = new Map<string, Map<string, string>>()
  // Only the folder the person picked may be on the network; a config file or a link must not send the app there.
  const picked = (path: string): boolean => isInside(source.path, path)
  const skippedNetwork = '已跳过网络位置，请把模型放在本机磁盘上，或直接添加那个文件夹'
  for (const { path, role, network, origin } of roots) {
    if ((network || isNetworkPath(path) || (await linksToNetwork(path))) && !picked(path)) {
      issues.push(skippedNetwork)
      addDetail({
        id: 'network:' + modelPathKey(origin ?? source.path),
        message: '已跳过配置中的网络位置',
        origin: origin ?? source.path,
        suggestion: '请把模型放在本机磁盘上，或通过「添加来源」直接选择该网络文件夹；如不需要可忽略此提示。',
      })
      continue
    }
    if (!resolved.has(path)) {
      const actual = await realpath(path).catch(() => null)
      resolved.set(path, actual && (await isDirectory(actual)) ? actual : null)
    }
    const actual = resolved.get(path)
    // A folder above the last part can still be a link to a share. linksToNetwork reads only the last part,
    // so such a share is contacted by realpath, but it is never scanned or loaded unless the person picked it.
    if (actual && isNetworkPath(actual) && !picked(actual)) {
      issues.push(skippedNetwork)
      addDetail({
        id: 'network:' + modelPathKey(origin ?? source.path),
        message: '已跳过配置中的网络位置',
        origin: origin ?? source.path,
        suggestion: '请把模型放在本机磁盘上，或通过「添加来源」直接选择该网络文件夹；如不需要可忽略此提示。',
      })
    } else if (actual && isTooBroadModelFolder(actual)) {
      issues.push('已跳过磁盘根目录或用户主目录，请选择具体的模型目录')
      addDetail({
        id: 'too-broad:' + modelPathKey(origin ?? source.path),
        message: '已跳过磁盘根目录或用户主目录',
        origin: origin ?? source.path,
        suggestion: '请在配置中改用具体的模型子目录；不影响其他有效目录，也可以直接忽略。',
      })
    } else if (actual) {
      unique.set(modelPathKey(actual), actual)
      if (role) roles.set(actual, role)
    } else if (origin) {
      // Missing paths in extra_model_paths.yaml / launch scripts are skipped like ComfyUI does,
      // and surfaced with their config file origin so the user can clean them up or dismiss the notice.
      let entries = missingByOrigin.get(origin)
      if (!entries) {
        entries = new Map<string, string>()
        missingByOrigin.set(origin, entries)
      }
      const key = modelPathKey(path)
      if (!entries.has(key)) entries.set(key, path)
    } else {
      issues.push('读不到模型目录：' + path)
      addDetail({
        id: 'missing-dir:' + modelPathKey(path),
        message: '读不到模型目录',
        origin: path,
        suggestion: '请检查该目录是否存在或具备读取权限，也可以点击「更换路径」重新选择。',
      })
    }
  }
  for (const [origin, entries] of missingByOrigin) {
    const missingPaths = [...entries.values()]
    issues.push(`已跳过配置中不存在的模型目录（来自 ${origin}）：${missingPaths.join('、')}`)
    addDetail({
      id: 'missing-config-dirs:' + modelPathKey(origin) + ':' + [...entries.keys()].sort().join('|'),
      message: missingPaths.length === 1 ? '已跳过配置中不存在的模型目录' : `已跳过配置中 ${missingPaths.length} 个不存在的模型目录`,
      origin,
      suggestion: '已像 ComfyUI 一样自动跳过，不影响读取当前目录里的其他模型；若这些旧路径已删除或迁移，可清理该配置文件，或点击「忽略」。',
      details: missingPaths,
    })
  }
  if (!unique.size && !issues.length) {
    issues.push('这个位置没有配置模型目录')
    addDetail({
      id: 'empty-source:' + modelPathKey(source.path),
      message: '这个位置没有配置模型目录',
      origin: source.path,
      suggestion: '请选择包含 models 文件夹的安装目录，或直接选择存放模型文件的文件夹。',
    })
  }
  return { roots: [...unique.values()], roles, issues: [...new Set(issues)], issueDetails }
}

export async function guessModelSourceKind(path: string): Promise<ModelSourceKind> {
  const base = /^models$/i.test(basename(path)) ? dirname(path) : path
  const kind = await installationKind(base)
  if (kind) return kind
  if (await isFile(path)) return /\.ya?ml$/i.test(path) ? 'comfyui' : 'custom'
  for (const location of [base, join(base, 'ComfyUI')]) {
    if ((await Promise.all(configNames.map((name) => isFile(join(location, name))))).some(Boolean)) return 'comfyui'
  }
  return 'custom'
}

export async function findModelSources(
  places: string[],
  installationHints: string[],
  profileLocations: string[],
): Promise<SourceLocation[]> {
  const isSpecificPath = (path: string): boolean =>
    isAbsolute(path) &&
    !isNetworkPath(path) &&
    resolve(path) !== parse(path).root &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(path))
  const candidates = new Set(installationHints.filter(isSpecificPath))
  const actualPlaces = await Promise.all(places.filter(isSpecificPath).map((place) => realpath(place).catch(() => null)))
  const uniquePlaces = new Map<string, string>()
  for (const place of actualPlaces) if (place && isSpecificPath(place)) uniquePlaces.set(modelPathKey(place), place)
  const entries = await Promise.all(
    [...uniquePlaces.values()].map(async (place) =>
      (await readdir(place, { withFileTypes: true }).catch(() => []))
        .filter((item) => item.isDirectory() || item.isSymbolicLink())
        .map((item) => join(place, item.name)),
    ),
  )
  for (const path of entries.flat()) if (!backupName.test(path)) candidates.add(path)

  const found = new Map<string, SourceLocation>()
  const coveredRuntimes = new Set<string>()
  const coveredProfiles = new Set<string>()
  for (const path of candidates) {
    if (backupName.test(path)) continue
    const actual = await realpath(path).catch(() => null)
    if (!actual || !isSpecificPath(actual) || backupName.test(actual) || found.has(modelPathKey(actual))) continue
    const kind = await installationKind(actual)
    if (!kind) continue
    const { roots } = await sourceRoots({ kind, path: actual }, profileLocations)
    if (!roots.length) continue
    found.set(modelPathKey(actual), { kind, path: actual })
    const desktop = await desktopProfileName(actual)
    if (desktop) coveredProfiles.add(desktop.toLowerCase())
    for (const nested of (await runtimeLocations(actual)).slice(1)) {
      const canonical = await realpath(nested).catch(() => null)
      if (canonical) coveredRuntimes.add(modelPathKey(canonical))
    }
  }
  for (const path of profileLocations) {
    if (coveredProfiles.has(basename(path).toLowerCase())) continue
    const actual = await realpath(path).catch(() => null)
    if (!actual || backupName.test(actual) || found.has(modelPathKey(actual))) continue
    const profile = await readDesktopProfile(actual)
    if (!profile.configs.length && !profile.roots.length) continue
    if (profile.aliases.some((alias) => found.has(modelPathKey(resolve(alias))))) continue
    const { roots } = await sourceRoots({ kind: 'comfyui', path: actual }, [])
    if (roots.length) found.set(modelPathKey(actual), { kind: 'comfyui', path: actual })
  }
  return [...found.entries()].filter(([key]) => !coveredRuntimes.has(key)).map(([, source]) => source)
}

export async function nearbyModelSources(probeServices = false): Promise<{
  sources: SourceLocation[]
  services?: Array<{ kind: Exclude<ModelSourceKind, 'custom'>; port: number }>
}> {
  const home = homedir()
  const windows = await windowsModelLocations()
  const places = [join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads'), join(home, 'Apps'), ...windows.places]
  if (process.platform === 'win32') {
    const windows = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ]
    places.push(...windows.filter((path): path is string => Boolean(path)))
  } else places.push(join(home, 'Applications'), '/opt')
  const hints = [...windows.installations]
  const services = probeServices ? await probeLocalModelServices(DEFAULT_SERVICE_PORTS) : undefined
  if (services) hints.push(...services.flatMap((service) => service.paths))
  const sources = await findModelSources(places, hints, desktopProfileLocations())
  return { sources, services: services?.map(({ kind, port }) => ({ kind, port })) }
}
