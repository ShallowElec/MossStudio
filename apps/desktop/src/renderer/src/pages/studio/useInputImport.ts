import { useCallback, useMemo, useRef } from 'react'
import { Ipc } from '@shared/channels'
import type { ProjectCanvas } from '@shared/types'
import { call } from '../../lib/api'
import { createImageCanvas } from './canvases'
import { MAX_REFERENCES, setLink, type LinkRole } from './links'
import { withStartPictureShape, withUpscaleSize } from './nodes'
import type { StudioProject } from './useStudioProject'

interface ImportedPicture {
  path: string
  width: number
  height: number
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 输入 › 添加 › 从文件 / 从作品选择: choose pictures, copy them into the project's
 * assets, put each on the board as a picture card next to the canvas and link
 * it into the role. The project is saved first when it is new (assets live in
 * its folder).
 */
export function useInputImport(options: {
  project: Pick<StudioProject, 'projectId' | 'saveNow' | 'canvasesRef' | 'setCanvases'>
  notify: (text: string, tone?: 'error' | 'info' | 'success') => void
}): {
  /** Import files as picture cards placed beside `near`; returns the new cards. */
  importPaths: (paths: readonly string[], near?: ProjectCanvas) => Promise<ProjectCanvas[]>
  /** Import pictures (a gallery item, say) and link them into `targetId`'s role; false when none went in. */
  addPaths: (targetId: string, role: LinkRole, kind: string | undefined, paths: readonly string[]) => Promise<boolean>
  /**
   * Pick files, then link them into the role of the canvas `target` names, or
   * makes once a file is chosen; resolves to that canvas's id, or null when
   * nothing was added.
   */
  addFromFile: (target: string | (() => string), role: LinkRole, kind?: string) => Promise<string | null>
} {
  const live = useRef(options)
  live.current = options

  const importPaths = useCallback(async (paths: readonly string[], near?: ProjectCanvas): Promise<ProjectCanvas[]> => {
    const { project, notify } = live.current
    const projectId = project.projectId ?? (await project.saveNow())?.id ?? null
    if (!projectId) {
      notify('项目还没保存好，图片暂时放不进来', 'error')
      return []
    }
    const created: ProjectCanvas[] = []
    const failed: string[] = []
    for (const path of paths) {
      try {
        const picture = await call<ImportedPicture>(Ipc.studioImportImage, { projectId, path })
        created.push(createImageCanvas([...project.canvasesRef.current, ...created], picture, near))
      } catch (error) {
        failed.push(`${path.split(/[\\/]/).pop() ?? path}：${message(error)}`)
      }
    }
    if (failed.length) notify(`有 ${failed.length} 张图片没有放进来。${failed[0]}`, 'error')
    if (created.length) project.setCanvases((previous) => [...previous, ...created])
    return created
  }, [])

  /** Copies pictures into the project and links them into a card's input. */
  const addPaths = useCallback(
    async (targetId: string, role: LinkRole, kind: string | undefined, paths: readonly string[]): Promise<boolean> => {
      const { project, notify } = live.current
      const target = project.canvasesRef.current.find((canvas) => canvas.id === targetId)
      if (!target) return false
      const room = role === 'reference' ? Math.max(0, MAX_REFERENCES - (target.inputs?.references?.links.length ?? 0)) : 1
      if (!paths.length || room === 0) return false
      if (paths.length > room) notify(`参考图最多 ${MAX_REFERENCES} 张，只放入了前 ${room} 张`, 'info')
      const created = await importPaths(paths.slice(0, room), target)
      if (!created.length) return false
      project.setCanvases((previous) => {
        const all = [...previous, ...created]
        return previous.map((canvas) => {
          if (canvas.id !== targetId) return canvas
          const linked = created.reduce((next, image) => setLink(next, role, { canvasId: image.id }, kind), canvas)
          // A 放大 takes its size from its 原图, a 画面 that never ran its shape from its first 起始图.
          return withStartPictureShape(withUpscaleSize(linked, all), all, canvas)
        })
      })
      return true
    },
    [importPaths],
  )

  const addFromFile = useCallback(
    async (target: string | (() => string), role: LinkRole, kind?: string): Promise<string | null> => {
      const { project, notify } = live.current
      if (typeof target === 'string' && !project.canvasesRef.current.some((canvas) => canvas.id === target)) return null
      let paths: string[]
      try {
        paths = await call<string[]>(Ipc.pickImages, {
          title: role === 'reference' ? '选择参考图' : role === 'control' ? '选择控制图' : '选择起始图',
        })
      } catch (error) {
        notify(message(error), 'error')
        return null
      }
      // A cancelled pick changes nothing: the canvas is made only now.
      if (!paths?.length) return null
      const targetId = typeof target === 'string' ? target : target()
      return (await addPaths(targetId, role, kind, paths)) ? targetId : null
    },
    [addPaths],
  )

  return useMemo(() => ({ importPaths, addPaths, addFromFile }), [importPaths, addPaths, addFromFile])
}
