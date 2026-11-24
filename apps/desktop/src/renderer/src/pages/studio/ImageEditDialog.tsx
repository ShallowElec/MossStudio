import { useEffect, useRef, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { ImageEditChannel } from '@shared/schemas'
import { Field, Select, Textarea } from '../../components/form'
import { Button, Modal } from '../../components/ui'
import { Notice } from '../../components/common/Notice'
import { call } from '../../lib/api'
import { cloverUrl } from '../../lib/clover'
import { dimensions } from '../../lib/format'
import { createImageCanvas } from './canvases'
import type { StudioProject } from './useStudioProject'

export function ImageEditDialog({ path, project, onClose }: { path: string; project: StudioProject; onClose: () => void }) {
  const [rows, setRows] = useState<ImageEditChannel[]>([]),
    [id, setId] = useState(''),
    [prompt, setPrompt] = useState(''),
    [error, setError] = useState(''),
    [size, setSize] = useState(''),
    [busy, setBusy] = useState(false)
  const active = useRef(true)
  const running = useRef<string | null>(null)
  useEffect(() => {
    active.current = true
    void call<ImageEditChannel[]>(Ipc.imageEditChannelsList)
      .then((cs) => (cs.length ? setRows(cs) : setError('请先在设置 › 功能中添加重绘渠道')))
      .catch(() => setError('无法读取渠道'))
    return () => {
      active.current = false
      // Closing the dialog, by 取消 or by leaving the Studio, stops the upload; its result would be dropped anyway.
      if (running.current) void call(Ipc.imageEditCancel, { runId: running.current }).catch(() => undefined)
    }
  }, [])
  const c = rows.find((r) => r.id === id) ?? rows[0]
  async function run() {
    if (!c || busy || !size) return
    setBusy(true)
    setError('')
    try {
      const projectId = project.projectId ?? (await project.saveNow())?.id
      if (!projectId || !active.current || project.currentId.current !== projectId) throw new Error('请重新打开项目')
      running.current = crypto.randomUUID()
      const request = { projectId, path, prompt, channelId: c.id, revision: c.revision, runId: running.current }
      const picture = await call<{ path: string; width: number; height: number }>(Ipc.imageEditRun, request)
      if (!active.current || project.currentId.current !== projectId) return
      const card = createImageCanvas(project.canvasesRef.current, picture)
      project.setCanvases((prev) => [...prev, card])
      project.select(card.id)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      running.current = null
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="外接重绘"
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>
            取消
          </Button>
          <Button tone="primary" disabled={busy || !size || !c || !prompt.trim()} onClick={() => void run()}>
            {busy ? '正在重绘…' : '发送并重绘'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <figure className="flex items-center gap-3">
          <img
            className="size-20 rounded-md object-contain"
            src={cloverUrl(path)}
            alt="即将上传的源图"
            onLoad={({ currentTarget: img }) => setSize(dimensions(img.naturalWidth, img.naturalHeight))}
            onError={() => setError('无法预览源图，请重新选择图片')}
          />
          <figcaption className="break-all text-caption">{[path.split(/[\\/]/).pop(), size].filter(Boolean).join(' · ')}</figcaption>
        </figure>
        <Field label="重绘渠道">
          <Select disabled={busy} value={c?.id ?? ''} onValueChange={setId} options={rows.map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        {c && <Notice>{`将图片和描述上传到 ${new URL(c.baseUrl).origin}，由 ${c.model} 重绘，可能产生费用。`}</Notice>}
        <Field label="重绘描述">
          <Textarea disabled={busy} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  )
}
