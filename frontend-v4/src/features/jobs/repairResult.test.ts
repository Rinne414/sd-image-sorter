import { describe, expect, test } from 'vitest'
import { readProgress } from './progress'
import { readRepairResult } from './repairResult'

describe('what a metadata repair found', () => {
  test('a recovery counts prompts and captions found; files that are gone count as still without text', () => {
    const result = { recovered: 10, captions_recovered: 5, still_missing: 380, missing_source: 3 }
    expect(readRepairResult('recover', result)).toEqual({ kind: 'recover', recovered: 10, captions: 5, still: 383 })
  })

  test('a ComfyUI re-read counts changed, unchanged, kept and missing files', () => {
    const result = { changed: 4, unchanged: 90, kept: 2, missing_source: 1 }
    expect(readRepairResult('comfy', result)).toEqual({ kind: 'comfy', changed: 4, unchanged: 90, kept: 2, missing: 1 })
  })

  test('no result yet reads as none', () => {
    expect(readRepairResult('comfy', {})).toBeNull()
    expect(readRepairResult('recover', null)).toBeNull()
  })
})

describe('the ComfyUI re-read in the drawer', () => {
  test('running over the images it walks, then done with the changed prompts as its count', () => {
    const ctx = { reparseJobId: 'c1' }
    expect(readProgress('recomfy', { job_id: 'c1', status: 'running', total: 50, processed: 10, result: {} }, ctx)).toMatchObject({ status: 'running', current: 10, total: 50 })
    const done = readProgress('recomfy', { job_id: 'c1', status: 'done', total: 50, processed: 50, result: { changed: 3, unchanged: 45, kept: 1, missing_source: 1 } }, ctx)
    expect(done).toMatchObject({ status: 'done', succeeded: 3, repair: { kind: 'comfy', changed: 3, unchanged: 45, kept: 1, missing: 1 } })
  })

  test('another job in its place is not ours', () => {
    expect(readProgress('recomfy', { job_id: 'other', status: 'running' }, { reparseJobId: 'c1' }).status).toBe('error')
  })
})

describe('colour analysis in the drawer', () => {
  test('a paused run stays running and says so; a stop asked for wins over a pause', () => {
    const paused = readProgress('colors', { running: true, paused: true, total: 100, completed: 20, failed: 1 })
    expect(paused).toMatchObject({ status: 'running', paused: true, current: 21, total: 100, succeeded: 20, failedCount: 1 })
    expect(readProgress('colors', { running: true, paused: false, total: 100, completed: 20, failed: 0 }).paused).toBe(false)
    expect(readProgress('colors', { running: true, paused: true, cancel_requested: true, total: 1, completed: 0, failed: 0 }).status).toBe('cancelling')
  })

  test('a run that ended after a stop is stopped, not done (so no next round follows)', () => {
    expect(readProgress('colors', { running: false, cancel_requested: true, total: 100, completed: 30, failed: 0 }).status).toBe('cancelled')
    expect(readProgress('colors', { running: false, cancel_requested: false, total: 100, completed: 100, failed: 0 }).status).toBe('done')
  })

  test('a run that ended is not paused', () => {
    expect(readProgress('colors', { running: false, paused: true, total: 10, completed: 10, failed: 0 })).toMatchObject({ status: 'done', paused: false })
  })
})
