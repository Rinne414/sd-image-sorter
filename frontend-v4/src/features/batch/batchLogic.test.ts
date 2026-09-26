import { describe, expect, test } from 'vitest'
import {
  copyName,
  currentAfterEdit,
  defaultBatchName,
  enabledSteps,
  moveCursor,
  moveStep,
  moveStepTo,
  restoreOrder,
  templateSettings,
  stepState,
  timeAgo,
  toggleStep,
} from './batchLogic'

const steps = [
  { id: 'pick', enabled: true },
  { id: 'censor', enabled: true },
  { id: 'order', enabled: false },
  { id: 'name', enabled: true },
  { id: 'export', enabled: true },
]

describe('step list edits', () => {
  test('enabled steps keep their order and drop the switched-off ones', () => {
    expect(enabledSteps(steps).map((s) => s.id)).toEqual(['pick', 'censor', 'name', 'export'])
  })

  test('moving a step up or down swaps it with its neighbour and never mutates the input', () => {
    const before = JSON.stringify(steps)
    expect(moveStep(steps, 'name', -1).map((s) => s.id)).toEqual(['pick', 'censor', 'name', 'order', 'export'])
    expect(moveStep(steps, 'censor', 1).map((s) => s.id)).toEqual(['pick', 'order', 'censor', 'name', 'export'])
    expect(JSON.stringify(steps)).toBe(before)
  })

  test('moving past either end returns the same list, so no save is needed', () => {
    expect(moveStep(steps, 'pick', -1)).toBe(steps)
    expect(moveStep(steps, 'export', 1)).toBe(steps)
    expect(moveStep(steps, 'nope', 1)).toBe(steps)
  })

  test('dragging a step drops it at the target index', () => {
    expect(moveStepTo(steps, 'export', 1).map((s) => s.id)).toEqual(['pick', 'export', 'censor', 'order', 'name'])
    expect(moveStepTo(steps, 'pick', 4).map((s) => s.id)).toEqual(['censor', 'order', 'name', 'export', 'pick'])
    expect(moveStepTo(steps, 'censor', 1)).toBe(steps)
  })

  test('toggling flips one step and keeps the rest', () => {
    const next = toggleStep(steps, 'order')
    expect(next.find((s) => s.id === 'order')?.enabled).toBe(true)
    expect(steps.find((s) => s.id === 'order')?.enabled).toBe(false)
    expect(toggleStep(next, 'censor').filter((s) => s.enabled).map((s) => s.id)).toEqual(['pick', 'order', 'name', 'export'])
  })

  test('the current step moves to the first switched-on step when it is switched off or gone', () => {
    expect(currentAfterEdit(steps, 'censor')).toBe('censor')
    expect(currentAfterEdit(steps, 'order')).toBe('pick')
    expect(currentAfterEdit(steps, 'gone')).toBe('pick')
    expect(currentAfterEdit(steps, null)).toBe('pick')
    const offFirst = toggleStep(steps, 'pick')
    expect(currentAfterEdit(offFirst, 'pick')).toBe('censor')
    expect(currentAfterEdit(steps.map((s) => ({ ...s, enabled: false })), 'name')).toBe('name')
  })

  test('steps before the current one are done, after it to do', () => {
    expect(stepState(steps, 'name', 'pick')).toBe('done')
    expect(stepState(steps, 'name', 'censor')).toBe('done')
    expect(stepState(steps, 'name', 'name')).toBe('current')
    expect(stepState(steps, 'name', 'export')).toBe('todo')
    // no current step yet: the first switched-on step is where the batch starts
    expect(stepState(steps, null, 'pick')).toBe('current')
    expect(stepState(steps, null, 'censor')).toBe('todo')
  })
})

describe('default batch names', () => {
  const day = new Date(2026, 8, 25, 14, 30)

  test('kind label plus a short date, in the UI language', () => {
    expect(defaultBatchName('Pixiv 投稿', day, 'zh-CN', [])).toBe('Pixiv 投稿 9月25日')
    expect(defaultBatchName('Pixiv post', day, 'en', [])).toBe('Pixiv post Sep 25')
  })

  test('a taken name gets the next free number', () => {
    const taken = ['Pixiv post Sep 25', 'Pixiv post Sep 25 (2)']
    expect(defaultBatchName('Pixiv post', day, 'en', taken)).toBe('Pixiv post Sep 25 (3)')
    expect(defaultBatchName('Dataset', day, 'en', taken)).toBe('Dataset Sep 25')
  })
})

describe('undoing a removal', () => {
  test('restored items go back to where they were', () => {
    // 3 was removed and appended again by the undo request
    expect(restoreOrder([1, 3, 5, 7], [1, 5, 7, 3])).toEqual([1, 3, 5, 7])
  })

  test('items added meanwhile stay at the end; items gone meanwhile are dropped', () => {
    expect(restoreOrder([1, 3, 5, 7], [1, 7, 9, 3])).toEqual([1, 3, 7, 9])
  })
})

describe('template settings', () => {
  test('keep the batch settings except where this batch came from', () => {
    const settings = { name_template: '{batch}_{n:02}', source_collection_id: 4, metadata_option: 'strip' }
    expect(templateSettings(settings)).toEqual({ name_template: '{batch}_{n:02}', metadata_option: 'strip' })
    expect(settings.source_collection_id).toBe(4)
    expect(templateSettings({})).toEqual({})
  })
})

describe('pick grid cursor', () => {
  test('arrows move by one or by a row and stay inside the grid', () => {
    expect(moveCursor(0, 10, 4, 'ArrowRight')).toBe(1)
    expect(moveCursor(0, 10, 4, 'ArrowLeft')).toBe(0)
    expect(moveCursor(1, 10, 4, 'ArrowDown')).toBe(5)
    expect(moveCursor(8, 10, 4, 'ArrowDown')).toBe(8)
    expect(moveCursor(6, 10, 4, 'ArrowDown')).toBe(9)
    expect(moveCursor(5, 10, 4, 'ArrowUp')).toBe(1)
    expect(moveCursor(2, 10, 4, 'ArrowUp')).toBe(2)
    expect(moveCursor(3, 10, 4, 'Home')).toBe(0)
    expect(moveCursor(3, 10, 4, 'End')).toBe(9)
  })

  test('no cursor yet: any arrow lands on the first item', () => {
    expect(moveCursor(-1, 10, 4, 'ArrowDown')).toBe(0)
    expect(moveCursor(-1, 0, 4, 'ArrowDown')).toBe(-1)
  })
})

describe('time ago', () => {
  const now = new Date('2026-09-25T12:00:00Z')

  test('recent times read as minutes, hours or days', () => {
    expect(timeAgo('2026-09-25T11:59:40Z', 'en', now)).toBe('just now')
    expect(timeAgo('2026-09-25T11:15:00Z', 'en', now)).toBe('45 minutes ago')
    expect(timeAgo('2026-09-25T09:00:00Z', 'en', now)).toBe('3 hours ago')
    expect(timeAgo('2026-09-23T12:00:00Z', 'en', now)).toBe('2 days ago')
    expect(timeAgo('2026-09-25T09:00:00Z', 'zh-CN', now)).toBe('3小时前')
  })

  test('a missing or broken time reads as nothing', () => {
    expect(timeAgo(null, 'en', now)).toBe('')
    expect(timeAgo('not a date', 'en', now)).toBe('')
  })
})

describe('the name a copy (Save as…) suggests', () => {
  test('the suggested name, or with (2), (3) when a batch or project already uses it, in any case', () => {
    expect(copyName('Faces 副本', [])).toBe('Faces 副本')
    expect(copyName('Faces (copy)', ['faces (COPY)'])).toBe('Faces (copy) (2)')
    expect(copyName('Faces (copy)', ['Faces (copy)', 'Faces (copy) (2)'])).toBe('Faces (copy) (3)')
  })
})
