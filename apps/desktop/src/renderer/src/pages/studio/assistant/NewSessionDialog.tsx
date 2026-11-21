import { FolderOpen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Advanced, Button, Field, FieldLabel, Input, Modal, Segmented, Select } from '../../../components/ui'
import type { CollabCreateSessionInput, AgentModelOption, CollabClient } from './collabClient'
import { workspaceKey } from './sessionBindings'

const NO_PROJECT = '__none__'
const NEW_PROJECT = '__new__'
const TYPED_FOLDER = ''

type FolderMode = 'existing' | 'create'

const FOLDER_MODES: Array<{ value: FolderMode; label: string }> = [
  { value: 'existing', label: '选择已有项目' },
  { value: 'create', label: '创建新项目' },
]

/** A folder the Agent already worked in. */
export interface WorkspaceOption {
  cwd: string
  label: string
}

/** A Studio project the conversation can be tied to. */
export interface CanvasProjectOption {
  id: string
  name: string
}

const DRIVE_ROOT = /^[a-zA-Z]:$/
const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|[\\/])/
const BAD_NAME = /[\\/:*?"<>|]/

function separatorOf(path: string): string {
  return path.includes('\\') || DRIVE_ROOT.test(path) ? '\\' : '/'
}

/** `F:\work\poster` → `F:\work`; a drive or `/` stays a root. Empty when there is no parent. */
export function parentFolder(path: string | undefined): string {
  const trimmed = (path ?? '').trim().replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index < 0) return ''
  const head = trimmed.slice(0, index)
  if (!head) return trimmed[0]!
  return DRIVE_ROOT.test(head) ? `${head}${trimmed[index]}` : head
}

/** The folder a new project gets: `parent` and `name` joined with the separator `parent` already uses. */
export function joinProjectPath(parent: string, name: string): string {
  const base = parent.trim()
  const leaf = name.trim()
  if (!base || !leaf) return ''
  const separator = separatorOf(base)
  const head = base.replace(/[\\/]+$/, '')
  return `${head}${separator}${leaf}`
}

/** Why the new project folder cannot be made, or an empty string when it can. */
export function newFolderProblem(parent: string, name: string): string {
  const base = parent.trim()
  const leaf = name.trim()
  if (!base) return '先选择新项目所在的目录。'
  if (!ABSOLUTE.test(base)) return '所在目录需要是完整路径，例如 D:\\work。'
  if (base.split(/[\\/]+/).includes('..')) return '所在目录不能包含 ..。'
  if (!leaf) return '给新项目文件夹起个名字。'
  if (BAD_NAME.test(leaf) || leaf.includes('..') || leaf === '.') return '文件夹名不能包含 / \\ : * ? " < > | 或 ..。'
  return ''
}

/**
 * A new conversation with its name, folder, project and starting model.
 * The folder is one the Agent used before, any folder on this computer, or a
 * new project folder made for it. No preset by default: the board reaches
 * every Agent through MCP tools and the Skill.
 */
export function NewSessionDialog({
  open,
  client,
  backendId,
  backendLabel,
  projectId,
  projectName,
  projects = [],
  workspaces = [],
  defaultCwd,
  onClose,
  onCreate,
  onCreateProject,
}: {
  open: boolean
  client: CollabClient
  backendId: string
  backendLabel: string
  projectId: string | null
  projectName: string
  /** Every saved Studio project. */
  projects?: readonly CanvasProjectOption[]
  /** Folders this Agent's conversations already use, newest first. */
  workspaces?: readonly WorkspaceOption[]
  defaultCwd?: string
  onClose: () => void
  onCreate: (input: CollabCreateSessionInput) => Promise<boolean>
  /** Saves a new, empty Studio project; its id, or null when that failed. */
  onCreateProject?: (name: string) => Promise<string | null>
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<FolderMode>('existing')
  const [cwd, setCwd] = useState(defaultCwd ?? '')
  const [parent, setParent] = useState('')
  const [folderName, setFolderName] = useState('')
  const [project, setProject] = useState(projectId ?? NO_PROJECT)
  const [newProjectName, setNewProjectName] = useState('')
  const [model, setModel] = useState('')
  const [preset, setPreset] = useState('')
  const [models, setModels] = useState<AgentModelOption[]>([])
  const [busy, setBusy] = useState(false)
  // Read when the dialog opens only: a background refresh must not wipe what is being typed.
  const latestWorkspaces = useRef(workspaces)
  latestWorkspaces.current = workspaces

  useEffect(() => {
    if (!open) return
    setTitle('')
    setMode('existing')
    setCwd(defaultCwd ?? '')
    setParent(parentFolder(defaultCwd ?? latestWorkspaces.current[0]?.cwd))
    setFolderName('')
    setProject(projectId ?? NO_PROJECT)
    setNewProjectName('')
    setModel('')
    setPreset('')
    setBusy(false)
    let active = true
    void client.listModels(backendId).then((catalog) => {
      if (active) setModels(catalog?.models ?? [])
    })
    return () => {
      active = false
    }
  }, [open, client, backendId, defaultCwd, projectId])

  const newFolder = joinProjectPath(parent, folderName)
  const folderProblem = mode === 'create' ? newFolderProblem(parent, folderName) : ''
  const projectProblem = project === NEW_PROJECT && !newProjectName.trim()
  const chosenWorkspace = workspaces.find((item) => workspaceKey(item.cwd) === workspaceKey(cwd))?.cwd ?? TYPED_FOLDER
  const otherProjects = projects.filter((item) => item.id !== projectId)

  function browse(heading: string, apply: (path: string) => void): void {
    void client
      .pickFolder(heading)
      .then((picked) => {
        if (picked) apply(picked)
      })
      .catch(() => undefined)
  }

  async function submit(): Promise<void> {
    if (busy || folderProblem || projectProblem) return
    setBusy(true)
    let linked = project === NO_PROJECT ? undefined : project
    if (project === NEW_PROJECT) {
      linked = (await onCreateProject?.(newProjectName.trim())) ?? undefined
      if (!linked) {
        setBusy(false)
        return
      }
      setProject(linked)
    }
    const option = models.find((item) => item.id === model)
    const folder = mode === 'create' ? { cwd: newFolder, createCwd: true } : cwd.trim() ? { cwd: cwd.trim() } : {}
    const input: CollabCreateSessionInput = {
      ...(title.trim() ? { title: title.trim().slice(0, 120) } : {}),
      ...folder,
      ...(linked ? { projectId: linked } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(option?.provider ? { provider: option.provider } : {}),
      ...(preset.trim() ? { agentPreset: preset.trim() } : {}),
    }
    const done = await onCreate(input)
    setBusy(false)
    if (done) onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建对话"
      width="max-w-md"
      footer={
        <>
          <Button tone="ghost" size="md" onClick={onClose}>
            取消
          </Button>
          <Button
            tone="primary"
            size="md"
            disabled={busy || Boolean(folderProblem) || projectProblem}
            onClick={() => void submit()}
            data-new-session-submit
          >
            {busy ? '创建中…' : '新建对话'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        data-new-session-form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Field label="对话名称">
          <Input value={title} maxLength={120} placeholder="例如：港口海报分镜" onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <div className="flex flex-col gap-2" data-workspace-mode={mode}>
          <FieldLabel>工作区 / 项目</FieldLabel>
          <Segmented<FolderMode> label="工作区 / 项目" block value={mode} options={FOLDER_MODES} onChange={setMode} />
          {mode === 'existing' ? (
            <>
              {workspaces.length ? (
                <Field label="这个 Agent 用过的项目">
                  <Select value={chosenWorkspace} onValueChange={(value) => value && setCwd(value)} data-workspace-select>
                    <option value={TYPED_FOLDER}>手动填写或浏览其他文件夹</option>
                    {workspaces.map((item) => (
                      <option key={workspaceKey(item.cwd)} value={item.cwd}>
                        {item.label} · {item.cwd}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <Field label="工作区目录">
                <div className="flex min-w-0 gap-1.5">
                  <Input
                    value={cwd}
                    maxLength={4096}
                    spellCheck={false}
                    placeholder="本机文件夹"
                    onChange={(event) => setCwd(event.target.value)}
                    className="min-w-0 flex-1"
                    data-workspace-cwd
                  />
                  <Button onClick={() => browse('选择工作区目录', setCwd)}>
                    <FolderOpen className="size-4" aria-hidden="true" strokeWidth={1.6} />
                    选择…
                  </Button>
                </div>
              </Field>
            </>
          ) : (
            <>
              <Field label="所在目录">
                <div className="flex min-w-0 gap-1.5">
                  <Input
                    value={parent}
                    maxLength={4000}
                    spellCheck={false}
                    placeholder="新项目放在哪个文件夹里"
                    onChange={(event) => setParent(event.target.value)}
                    className="min-w-0 flex-1"
                    data-new-project-parent
                  />
                  <Button onClick={() => browse('选择新项目所在的目录', setParent)}>
                    <FolderOpen className="size-4" aria-hidden="true" strokeWidth={1.6} />
                    选择…
                  </Button>
                </div>
              </Field>
              <Field
                label="新项目文件夹名"
                hint={
                  <span className="[overflow-wrap:anywhere]" data-new-project-path={folderProblem ? '' : newFolder}>
                    {folderProblem || `将创建：${newFolder}`}
                  </span>
                }
              >
                <Input
                  value={folderName}
                  maxLength={120}
                  spellCheck={false}
                  placeholder="例如：harbor-poster"
                  onChange={(event) => setFolderName(event.target.value)}
                  data-new-project-name
                />
              </Field>
            </>
          )}
        </div>
        <Field label="关联画布项目">
          <Select value={project} onValueChange={setProject} data-project-select>
            {projectId ? <option value={projectId}>当前项目：{projectName}</option> : null}
            {otherProjects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
            {onCreateProject ? <option value={NEW_PROJECT}>新建画布项目…</option> : null}
            <option value={NO_PROJECT}>不关联</option>
          </Select>
        </Field>
        {project === NEW_PROJECT ? (
          <Field label="新画布项目名称">
            <Input
              value={newProjectName}
              maxLength={200}
              placeholder="例如：港口海报"
              onChange={(event) => setNewProjectName(event.target.value)}
              data-new-canvas-project
            />
          </Field>
        ) : null}
        <Field label="初始模型">
          {models.length ? (
            <Select value={model} onValueChange={setModel}>
              <option value="">Agent 默认</option>
              {models.map((item) => (
                <option key={`${item.provider ?? ''}/${item.id}`} value={item.id}>
                  {item.label}
                  {item.provider ? ` · ${item.provider}` : ''}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={model}
              maxLength={200}
              spellCheck={false}
              placeholder="Agent 默认"
              onChange={(event) => setModel(event.target.value)}
            />
          )}
        </Field>
        <div className="rounded-lg bg-well">
          <Advanced summary="高级选项">
            <div className="px-3.5 pb-3">
              <Field label="Agent 预设（可选）">
                <Input
                  value={preset}
                  maxLength={80}
                  spellCheck={false}
                  placeholder="不使用预设"
                  onChange={(event) => setPreset(event.target.value)}
                />
              </Field>
            </div>
          </Advanced>
        </div>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  )
}
