import { describe, expect, test } from 'vitest'
import { isFinished, readProgress } from './progress'

describe('readProgress', () => {
  test('move while running: counts, current file, the last errors with names', () => {
    const p = readProgress('move', {
      status: 'running',
      current: 3,
      total: 10,
      moved: 2,
      errors: 1,
      current_item: 'c.png',
      recent_errors: [{ image_id: 7, filename: 'b.png', error: 'Failed to move image: file is locked' }],
      results: [],
    })
    expect(p).toMatchObject({ status: 'running', current: 3, total: 10, succeeded: 2, failedCount: 1, currentItem: 'c.png' })
    expect(p.failures).toEqual([{ id: 7, name: 'b.png', reason: 'Failed to move image: file is locked' }])
    expect(isFinished(p.status)).toBe(false)
  })

  test('move done: every failed id comes from the full results list', () => {
    const p = readProgress('copy', {
      status: 'done',
      current: 3,
      total: 3,
      moved: 1,
      errors: 2,
      recent_errors: [{ image_id: 9, filename: 'z.png', error: 'x' }],
      results: [
        { id: 1, success: true, new_path: 'D:\\k\\a.png' },
        { id: 8, success: false, error: 'Image not found' },
        { id: 9, success: false, error: 'Failed to copy image: disk full' },
      ],
    })
    expect(p).toMatchObject({ status: 'done', succeeded: 1, failedCount: 2 })
    expect(p.failures).toEqual([
      { id: 8, name: '', reason: 'Image not found' },
      { id: 9, name: 'z.png', reason: 'Failed to copy image: disk full' },
    ])
    expect(isFinished(p.status)).toBe(true)
  })

  test('trash: deleted count and the per-image failed list', () => {
    const p = readProgress('trash', {
      status: 'cancelled',
      current: 4,
      total: 9,
      deleted: 3,
      errors: 1,
      failed: [{ image_id: 5, filename: 'e.png', error: 'Recycle Bin is not available' }],
    })
    expect(p).toMatchObject({ status: 'cancelled', current: 4, total: 9, succeeded: 3, failedCount: 1 })
    expect(p.failures).toEqual([{ id: 5, name: 'e.png', reason: 'Recycle Bin is not available' }])
  })

  test('remove: records only, rows that were already gone are not failures', () => {
    const p = readProgress('remove', { status: 'done', current: 5, total: 5, removed: 4, missing_ids: [12] })
    expect(p).toMatchObject({ status: 'done', succeeded: 4, failedCount: 0, alreadyGone: 1, failures: [] })
  })

  test('unknown or reset states never look like success', () => {
    expect(readProgress('move', { status: 'idle' }).status).toBe('idle')
    expect(readProgress('move', { status: 'exploded' }).status).toBe('error')
    expect(readProgress('move', null).status).toBe('error')
    expect(readProgress('move', { status: 'cancelling', current: 1, total: 2 }).status).toBe('cancelling')
  })
})
