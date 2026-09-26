import { describe, expect, test } from 'vitest'
import { isFinished, readProgress } from './progress'

describe('auto-masking a dataset in the drawer', () => {
  test('queued, then running with images counted', () => {
    expect(readProgress('masks', { job_id: 'm1', status: 'queued', total: 5, processed: 0 }, { maskJobId: 'm1' }).status).toBe('queued')
    const p = readProgress('masks', { job_id: 'm1', status: 'running', total: 5, processed: 2, result: {} }, { maskJobId: 'm1' })
    expect(p).toMatchObject({ status: 'running', current: 2, total: 5 })
  })

  test('done: masks saved, and each image that failed named with its reason', () => {
    const raw = {
      job_id: 'm1',
      status: 'done',
      total: 5,
      processed: 5,
      error_count: 0,
      result: { saved: 3, skipped: 1, error_count: 1, errors: [{ image_id: 12, error: 'Source image missing on disk' }] },
    }
    const p = readProgress('masks', raw, { maskJobId: 'm1' })
    expect(p).toMatchObject({ status: 'done', succeeded: 3, failedCount: 1 })
    expect(p.failures).toEqual([{ id: 12, name: '', reason: 'Source image missing on disk' }])
    expect(isFinished(p.status)).toBe(true)
  })

  test('another job in its place or a failed one is not success; the reason is kept', () => {
    expect(readProgress('masks', { job_id: 'other', status: 'running' }, { maskJobId: 'm1' }).status).toBe('error')
    expect(readProgress('masks', { job_id: 'm1', status: 'error', message: 'rembg is not installed' }, { maskJobId: 'm1' })).toMatchObject({
      status: 'error',
      message: 'rembg is not installed',
    })
  })
})
