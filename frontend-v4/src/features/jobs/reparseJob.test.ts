import { describe, expect, test } from 'vitest'
import { isFinished, readProgress } from './progress'

describe('recovering missing text in the drawer', () => {
  test('queued until it starts, then running over the images it walks', () => {
    expect(readProgress('reparse', { job_id: 'r1', status: 'queued', total: 0, processed: 0 }, { reparseJobId: 'r1' }).status).toBe('queued')
    const p = readProgress('reparse', { job_id: 'r1', status: 'running', total: 400, processed: 100, result: {} }, { reparseJobId: 'r1' })
    expect(p).toMatchObject({ status: 'running', current: 100, total: 400 })
  })

  test('done: prompts and sidecar captions found both count as text found; real errors are failures', () => {
    const raw = {
      job_id: 'r1',
      status: 'done',
      total: 400,
      processed: 400,
      error_count: 2,
      result: { recovered: 10, captions_recovered: 5, still_missing: 380, used_raw: 8, used_file: 7, missing_source: 3 },
    }
    const p = readProgress('reparse', raw, { reparseJobId: 'r1' })
    expect(p).toMatchObject({ status: 'done', succeeded: 15, failedCount: 2 })
    expect(isFinished(p.status)).toBe(true)
  })
})

describe('re-reading details that failed to read', () => {
  test('fixed ones succeed; ones that still fail or no longer open are failures; vanished files are neither', () => {
    const raw = {
      job_id: 'r2',
      status: 'done',
      total: 9,
      processed: 9,
      error_count: 0,
      result: { scope: 'metadata_error', fixed: 5, still_error: 2, unreadable: 1, gone: 1 },
    }
    expect(readProgress('reread', raw, { reparseJobId: 'r2' })).toMatchObject({ status: 'done', succeeded: 5, failedCount: 3 })
  })

  test('another job in its place is not ours; a failed run keeps its reason', () => {
    expect(readProgress('reread', { job_id: 'other', status: 'running' }, { reparseJobId: 'r2' }).status).toBe('error')
    expect(readProgress('reread', { job_id: 'r2', status: 'error', message: 'database is locked' }, { reparseJobId: 'r2' })).toMatchObject({
      status: 'error',
      message: 'database is locked',
    })
  })
})
