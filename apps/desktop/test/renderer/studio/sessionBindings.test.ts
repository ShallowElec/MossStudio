import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  adoptSessionBinding,
  bindNewSession,
  bindSession,
  groupByWorkspace,
  pinnedSessionsKey,
  projectSessions,
  readSessionBinding,
  sessionBindingKey,
  setSessionsResumable,
  unbindSession,
  workspaceKey,
} from '@renderer/pages/studio/assistant/sessionBindings'

// These Agents keep their conversations across a restart; the last describe covers one that does not.
beforeEach(() => setSessionsResumable('codex-acp', true))
afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  setSessionsResumable('codex-acp', false)
})

describe('bindings of an Agent that cannot resume conversations', () => {
  it('last for this run only, so a restarted app never lists conversations that are gone', () => {
    setSessionsResumable('codex-acp', false)
    bindSession('codex-acp', 'p1', 's1')
    expect(readSessionBinding('codex-acp', 'p1')).toEqual({ currentId: 's1', pinnedIds: ['s1'] })
    expect(localStorage.getItem(sessionBindingKey('codex-acp', 'p1'))).toBeNull()
    sessionStorage.clear()
    expect(readSessionBinding('codex-acp', 'p1')).toEqual({ currentId: '', pinnedIds: [] })
  })
})

describe('a conversation made for another project', () => {
  it('is pinned to that project only, and leaves the open project as it was', () => {
    bindSession('codex-acp', 'open', 's1')
    expect(bindNewSession('codex-acp', 'open', 'other', 's2')).toEqual({ currentId: 's1', pinnedIds: ['s1'] })
    expect(readSessionBinding('codex-acp', 'other').pinnedIds).toEqual(['s2'])
    expect(bindNewSession('codex-acp', 'open', 'open', 's3').pinnedIds).toEqual(['s1', 's3'])
    expect(bindNewSession('codex-acp', 'open', undefined, 's4').currentId).toBe('s4')
  })
})

describe('project session bindings', () => {
  it('keeps every conversation a project started or chose, per Agent and per project', () => {
    expect(readSessionBinding('codex-acp', 'p1')).toEqual({ currentId: '', pinnedIds: [] })
    bindSession('codex-acp', 'p1', 's1')
    expect(bindSession('codex-acp', 'p1', 's2')).toEqual({ currentId: 's2', pinnedIds: ['s1', 's2'] })
    // Choosing a pinned one again does not duplicate it.
    expect(bindSession('codex-acp', 'p1', 's1')).toEqual({ currentId: 's1', pinnedIds: ['s1', 's2'] })
    expect(readSessionBinding('codex-acp', 'p1')).toEqual({ currentId: 's1', pinnedIds: ['s1', 's2'] })
    expect(readSessionBinding('codex-acp', 'p2').pinnedIds).toEqual([])
    expect(readSessionBinding('custom-acp', 'p1').pinnedIds).toEqual([])
    expect(readSessionBinding('codex-acp', null)).toEqual({ currentId: '', pinnedIds: [] })
  })

  it('takes a conversation out of the project without touching the rest', () => {
    bindSession('codex-acp', 'p1', 's1')
    bindSession('codex-acp', 'p1', 's2')
    bindSession('codex-acp', 'p2', 's1')
    expect(unbindSession('codex-acp', 'p1', 's2')).toEqual({ currentId: '', pinnedIds: ['s1'] })
    expect(unbindSession('codex-acp', 'p1', 'gone')).toEqual({ currentId: '', pinnedIds: ['s1'] })
    expect(localStorage.getItem(sessionBindingKey('codex-acp', 'p1'))).toBeNull()
    expect(readSessionBinding('codex-acp', 'p2')).toEqual({ currentId: 's1', pinnedIds: ['s1'] })
  })

  it('turns a conversation remembered before pins existed into the first pin, and survives a damaged list', () => {
    localStorage.setItem(sessionBindingKey('codex-acp', 'p1'), 'old')
    expect(readSessionBinding('codex-acp', 'p1')).toEqual({ currentId: 'old', pinnedIds: ['old'] })
    localStorage.setItem(pinnedSessionsKey('codex-acp', 'p1'), '{not json')
    expect(readSessionBinding('codex-acp', 'p1').pinnedIds).toEqual(['old'])
    localStorage.setItem(pinnedSessionsKey('codex-acp', 'p1'), JSON.stringify(['a', 3, '', 'a', 'b']))
    expect(readSessionBinding('codex-acp', 'p1').pinnedIds).toEqual(['a', 'b', 'old'])
  })

  it('moves the conversations of an unsaved project to its id once saved, but never over an existing binding', () => {
    const unsaved = bindSession('codex-acp', null, 's1')
    expect(adoptSessionBinding('codex-acp', 'p1', unsaved)).toEqual({ currentId: 's1', pinnedIds: ['s1'] })
    bindSession('codex-acp', 'p2', 'mine')
    expect(adoptSessionBinding('codex-acp', 'p2', unsaved)).toEqual({ currentId: 'mine', pinnedIds: ['mine'] })
    expect(adoptSessionBinding('codex-acp', 'p3', { currentId: '', pinnedIds: [] })).toEqual({ currentId: '', pinnedIds: [] })
    expect(localStorage.getItem(pinnedSessionsKey('codex-acp', 'p3'))).toBeNull()
  })

  it('lists only the pinned conversations the Agent still has, in pin order', () => {
    const sessions = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]
    expect(projectSessions(sessions, ['c', 'gone', 'a']).map((item) => item.id)).toEqual(['c', 'a'])
    expect(projectSessions([], ['a'])).toEqual([])
  })
})

describe('groupByWorkspace', () => {
  it('groups conversations by working folder, newest folder first and folderless last', () => {
    const groups = groupByWorkspace([
      { id: 'a1', title: 'a1', cwd: 'F:\\work\\poster', updatedAt: 1 },
      { id: 'n1', title: 'n1', updatedAt: 99 },
      { id: 'b1', title: 'b1', cwd: '/home/me/comic', updatedAt: 5 },
      { id: 'a2', title: 'a2', cwd: 'f:/work/poster/', updatedAt: 9 },
    ])
    expect(groups.map((group) => [group.label, group.sessions.map((item) => item.id)])).toEqual([
      ['poster', ['a2', 'a1']],
      ['comic', ['b1']],
      ['未指定工作区', ['n1']],
    ])
    expect(groups[0]).toMatchObject({ key: 'f:/work/poster', cwd: 'F:\\work\\poster', updatedAt: 9 })
    expect(groups[2]!.key).toBe('')
    expect(groupByWorkspace([])).toEqual([])
  })

  it('normalises folder keys for grouping', () => {
    expect(workspaceKey(undefined)).toBe('')
    expect(workspaceKey('  ')).toBe('')
    expect(workspaceKey('C:\\Repo\\')).toBe('c:/repo')
    expect(workspaceKey('/')).toBe('/')
  })
})
