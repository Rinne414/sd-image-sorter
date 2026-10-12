import { describe, expect, test } from 'vitest'
import { isFinished, readProgress, type JobProgress } from './progress'

// GET /api/artists/batch-progress: a running flag and a step word
// (starting, loading_runtime, identifying, done, error, idle). `processed`
// counts identified images, `errors` the failed ones; a stopped run ends as
// "done" short of its total.

describe('artist identification in the drawer', () => {
  test('running: handled images (identified + failed) out of the total, the file in hand named', () => {
    const p = readProgress('artist', { running: true, step: 'identifying', total: 40, processed: 10, errors: 2, current_item: 'a.png', results: [] })
    expect(p).toMatchObject({ status: 'running', current: 12, total: 40, succeeded: 10, failedCount: 2, currentItem: 'a.png' })
    expect(isFinished(p.status)).toBe(false)
  })

  test('while the model loads it says so instead of a file name', () => {
    const p = readProgress('artist', { running: true, step: 'loading_runtime', total: 5, processed: 0, errors: 0, current_item: null })
    expect(p.status).toBe('running')
    expect(p.currentItem).toBeTruthy()
    expect(p.current).toBe(0)
  })

  test('done: every image handled', () => {
    const p = readProgress('artist', { running: false, step: 'done', total: 3, processed: 2, errors: 1 })
    expect(p).toMatchObject({ status: 'done', current: 3, succeeded: 2, failedCount: 1, currentItem: null })
  })

  test('a run that ended short of its total was stopped', () => {
    expect(readProgress('artist', { running: false, step: 'done', total: 10, processed: 4, errors: 0 }).status).toBe('cancelled')
  })

  test('a crash is an error with its reason', () => {
    const p = readProgress('artist', { running: false, step: 'error', total: 10, processed: 1, errors: 0, message: 'Artist identification failed: CUDA out of memory' })
    expect(p).toMatchObject({ status: 'error', message: 'Artist identification failed: CUDA out of memory' })
  })

  test('nothing on the backend (it restarted) means the job was reset', () => {
    expect(readProgress('artist', { running: false, step: 'idle', total: 0, processed: 0, errors: 0 }).status).toBe('idle')
  })

  test('a stop asked for stays "stopping" while the backend still runs', () => {
    const prev = { ...readProgress('artist', { running: true, step: 'identifying', total: 5, processed: 1, errors: 0 }), status: 'cancelling' } as JobProgress
    expect(readProgress('artist', { running: true, step: 'identifying', total: 5, processed: 2, errors: 0 }, {}, prev).status).toBe('cancelling')
  })
})
