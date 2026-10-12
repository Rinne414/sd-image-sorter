import { describe, expect, test } from 'vitest'
import { isFinished, readProgress } from './progress'

// GET /api/aesthetic/progress (a whole-library run) and the page's own run
// over picked images report the same shape: `completed` counts every image
// handled, failures included.

describe('aesthetic scoring in the drawer', () => {
  test('running: images handled out of the total, the one in hand named', () => {
    const p = readProgress('aesthetic', { running: true, total: 40, completed: 12, errors: 2, current: 'C:\\x\\a.png', error: null })
    expect(p).toMatchObject({ status: 'running', current: 12, total: 40, succeeded: 10, failedCount: 2, currentItem: 'C:\\x\\a.png' })
    expect(isFinished(p.status)).toBe(false)
  })

  test('done: every image handled; the scored ones are the successes', () => {
    const p = readProgress('aesthetic', { running: false, total: 3, completed: 3, errors: 1, error: null, failed: [{ image_id: 9, error: 'File not found' }] })
    expect(p).toMatchObject({ status: 'done', succeeded: 2, failedCount: 1 })
    expect(p.failures).toEqual([{ id: 9, name: '', reason: 'File not found' }])
  })

  test('stopped part way is "stopped", not done', () => {
    expect(readProgress('aesthetic', { running: false, total: 10, completed: 4, errors: 0, error: null }).status).toBe('cancelled')
    expect(readProgress('aesthetic', { running: false, total: 10, completed: 10, errors: 0, cancelled: true }).status).toBe('cancelled')
  })

  test('a crash or an unusable model is an error with its reason', () => {
    const p = readProgress('aesthetic', { running: false, total: 10, completed: 1, errors: 0, error: 'CUDA out of memory' })
    expect(p).toMatchObject({ status: 'error', message: 'CUDA out of memory' })
  })

  test('a stop asked for while it still runs', () => {
    expect(readProgress('aesthetic', { running: true, total: 5, completed: 1, cancel_requested: true }).status).toBe('cancelling')
  })
})
