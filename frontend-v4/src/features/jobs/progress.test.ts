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

  test('tag: a run older than ours is ours still waiting, never an early "done"', () => {
    const stale = { status: 'done', run_id: 4, current: 50, total: 50, tagged: 50, errors: 0, pipeline_queue: { total_queued: 1 } }
    expect(readProgress('tag', stale, { baseRunId: 4 })).toMatchObject({ status: 'queued', current: 0 })
    expect(readProgress('tag', { ...stale, pipeline_queue: { total_queued: 0 } }, { baseRunId: 4 }).status).toBe('running')
  })

  test('tag: counts, failures and the most common tags of our run', () => {
    const p = readProgress(
      'tag',
      {
        status: 'done',
        run_id: 5,
        current: 3,
        total: 3,
        tagged: 2,
        errors: 1,
        last_run_stats: { top_tags: [{ tag: '1girl', count: 2 }, { tag: 'solo', count: 1 }] },
      },
      { baseRunId: 4 },
    )
    expect(p).toMatchObject({ status: 'done', current: 3, total: 3, succeeded: 2, failedCount: 1, unit: 'images' })
    expect(p.topTags).toEqual([
      { tag: '1girl', count: 2 },
      { tag: 'solo', count: 1 },
    ])
  })

  test('install: bytes while downloading, then the settled result for our model', () => {
    const idle = { active: false, downloaded: 0, total: 0, prepare_result: { active: false, model_id: '', status: '' } }
    expect(readProgress('install', idle, { modelId: 'wd14' }).status).toBe('running')

    const downloading = { active: true, downloaded: 100, total: 400, filename: 'model.onnx', prepare_result: { active: true, model_id: 'wd14' } }
    expect(readProgress('install', downloading, { modelId: 'wd14' })).toMatchObject({
      status: 'running',
      current: 100,
      total: 400,
      unit: 'bytes',
      currentItem: 'model.onnx',
    })

    const ok = { active: false, prepare_result: { active: false, model_id: 'wd14', status: 'ok', message: 'ready' } }
    expect(readProgress('install', ok, { modelId: 'wd14' })).toMatchObject({ status: 'done', needsRestart: false })

    // Recommended (e.g. the GPU runtime was repaired): usable now, fully after a restart.
    const advised = { prepare_result: { active: false, model_id: 'wd14', status: 'ok', restart_recommended: true, message: 'restart' } }
    expect(readProgress('install', advised, { modelId: 'wd14' })).toMatchObject({ status: 'done', needsRestart: false, restartAdvised: true })
    // Required: not usable until the app restarts.
    const required = { prepare_result: { active: false, model_id: 'toriigate', status: 'needs_restart', message: 'restart' } }
    expect(readProgress('install', required, { modelId: 'toriigate' })).toMatchObject({ status: 'done', needsRestart: true })

    const failed = { prepare_result: { active: false, model_id: 'wd14', status: 'error', message: '', error: 'HTTP 403' } }
    expect(readProgress('install', failed, { modelId: 'wd14' })).toMatchObject({ status: 'error', message: 'HTTP 403' })

    const other = { prepare_result: { active: false, model_id: 'clip', status: 'ok' } }
    expect(readProgress('install', other, { modelId: 'wd14' }).status).toBe('running')
  })

  test('colors: running with counts, then done when the backend stops', () => {
    const running = { running: true, cancel_requested: false, total: 10, completed: 3, failed: 1, current_image: 'x.png' }
    expect(readProgress('colors', running)).toMatchObject({
      status: 'running',
      current: 4,
      total: 10,
      succeeded: 3,
      failedCount: 1,
      currentItem: 'x.png',
    })
    expect(readProgress('colors', { ...running, cancel_requested: true }).status).toBe('cancelling')
    expect(readProgress('colors', { ...running, running: false, completed: 9 })).toMatchObject({ status: 'done', succeeded: 9 })
  })

  test('reconnect: files checked, records found again, and matches left for review', () => {
    const p = readProgress('reconnect', {
      status: 'done',
      current: 120,
      total: 120,
      checked_files: 120,
      matched: 40,
      ambiguous: 3,
      review_pending_total: 3,
      errors: 1,
      current_item: null,
    })
    expect(p).toMatchObject({ status: 'done', current: 120, total: 120, succeeded: 40, failedCount: 1, toReview: 3 })
    expect(readProgress('reconnect', { status: 'running', current: 10, total: 0, matched: 2 })).toMatchObject({
      status: 'running',
      succeeded: 2,
      toReview: 0,
    })
  })

  test('scan: files first, then generation details, then done with new and updated counts', () => {
    const counting = { run_id: 9, status: 'starting', processed: 0, total: 0, counted: 40, total_final: false, new: 0, updated: 0, errors: 0 }
    expect(readProgress('scan', counting, { runId: 9 })).toMatchObject({ status: 'running', phase: 'files', current: 0, total: 40 })

    const files = { ...counting, status: 'running', processed: 25, total: 60, total_final: true, new: 20, current_item: 'a.png' }
    expect(readProgress('scan', files, { runId: 9 })).toMatchObject({ phase: 'files', current: 25, total: 60, succeeded: 20, currentItem: 'a.png' })

    const details = { ...files, processed: 60, import_complete: true, metadata_processed: 10, metadata_total: 60, metadata_pending: 50 }
    expect(readProgress('scan', details, { runId: 9 })).toMatchObject({ phase: 'details', current: 10, total: 60 })

    const done = { ...details, status: 'done', metadata_pending: 0, new: 55, updated: 5, errors: 2 }
    expect(readProgress('scan', done, { runId: 9 })).toMatchObject({ status: 'done', succeeded: 55, updated: 5, failedCount: 2 })
  })

  test('scan: another run on the backend is not ours', () => {
    expect(readProgress('scan', { run_id: 10, status: 'running' }, { runId: 9 }).status).toBe('idle')
  })

  test('detect and refine (run in this page): counts, the image being worked on, failures by name', () => {
    const running = { status: 'running', current: 1, total: 3, succeeded: 1, failed: [], current_item: 'b.png' }
    expect(readProgress('detect', running)).toMatchObject({ status: 'running', current: 1, total: 3, succeeded: 1, failedCount: 0, currentItem: 'b.png' })
    const done = {
      status: 'cancelled',
      current: 2,
      total: 3,
      succeeded: 1,
      failed: [{ image_id: 12, filename: 'b.png', error: 'NudeNet could not read image file' }],
    }
    expect(readProgress('adjust', done).failures).toHaveLength(1)
    const p = readProgress('refine', done)
    expect(p).toMatchObject({ status: 'cancelled', current: 2, succeeded: 1, failedCount: 1 })
    expect(p.failures).toEqual([{ id: 12, name: 'b.png', reason: 'NudeNet could not read image file' }])
    expect(isFinished(p.status)).toBe(true)
    // the page was reloaded while it ran: nothing reports any more
    expect(readProgress('detect', null).status).toBe('error')
  })

  test('unknown or reset states never look like success', () => {
    expect(readProgress('move', { status: 'idle' }).status).toBe('idle')
    expect(readProgress('move', { status: 'exploded' }).status).toBe('error')
    expect(readProgress('move', null).status).toBe('error')
    expect(readProgress('move', { status: 'cancelling', current: 1, total: 2 }).status).toBe('cancelling')
  })
})
