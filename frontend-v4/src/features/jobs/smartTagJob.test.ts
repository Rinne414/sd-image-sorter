import { describe, expect, test } from 'vitest'
import { isFinished, readProgress } from './progress'
import { startedJobId } from './smartTagJob'

describe('a Smart Tag run in the drawer', () => {
  test('waiting in the AI queue behind other work: queued, with nothing counted yet', () => {
    const someoneElse = { job_id: 'other', status: 'running', total: 9, processed: 4, pipeline_queue: { total_queued: 1, queued: [{ queue_id: 'q3' }] } }
    const p = readProgress('smarttag', someoneElse, { smartTag: { queueId: 'q3' } })
    expect(p).toMatchObject({ status: 'queued', current: 0, total: 0 })
    expect(isFinished(p.status)).toBe(false)
  })

  test('running: counts, and failures named by id (Library) or path (folder)', () => {
    const raw = {
      job_id: 's1',
      status: 'running',
      total: 5,
      processed: 2,
      succeeded: 1,
      failed: 1,
      errors: [{ image_id: 'D:/set/a.png', error: 'Image path not found' }],
    }
    const p = readProgress('smarttag', raw, { smartTag: { jobId: 's1' } })
    expect(p).toMatchObject({ status: 'running', current: 2, total: 5, succeeded: 1, failedCount: 1 })
    expect(p.failures).toEqual([{ id: null, name: 'D:/set/a.png', reason: 'Image path not found' }])
    const byId = readProgress('smarttag', { ...raw, errors: [{ image_id: '12', error: 'x' }] }, { smartTag: { jobId: 's1' } })
    expect(byId.failures).toEqual([{ id: 12, name: '', reason: 'x' }])
  })

  test('its end states: completed and warning are done, failed says why, cancelled and gone are not success', () => {
    const ctx = { smartTag: { jobId: 's1' } }
    const done = { job_id: 's1', status: 'completed', total: 5, processed: 5, succeeded: 5, failed: 0, errors: [] }
    expect(readProgress('smarttag', done, ctx)).toMatchObject({ status: 'done', succeeded: 5, current: 5 })
    expect(readProgress('smarttag', { ...done, status: 'warning' }, ctx).status).toBe('done')
    expect(readProgress('smarttag', { job_id: 's1', status: 'failed', message: 'No VLM endpoint' }, ctx)).toMatchObject({
      status: 'error',
      message: 'No VLM endpoint',
    })
    expect(readProgress('smarttag', { job_id: 's1', status: 'cancelled' }, ctx).status).toBe('cancelled')
    // the backend forgot the job (it restarted)
    expect(readProgress('smarttag', { status: 'idle', active: false }, ctx).status).toBe('idle')
    // another run's snapshot is never read as ours
    expect(readProgress('smarttag', { ...done, job_id: 'x' }, ctx).status).toBe('error')
    expect(readProgress('smarttag', null, ctx).status).toBe('error')
  })

  test('a queued run is ours once it left the queue and a run is active', () => {
    const queue = (ids: string[]) => ({ total_queued: ids.length, queued: ids.map((queue_id) => ({ queue_id })) })
    expect(startedJobId({ job_id: 'other', active: true, pipeline_queue: queue(['q3']) }, 'q3')).toBeNull()
    expect(startedJobId({ job_id: 's7', active: true, pipeline_queue: queue([]) }, 'q3')).toBe('s7')
    // between runs: nothing active yet
    expect(startedJobId({ status: 'idle', active: false, pipeline_queue: queue([]) }, 'q3')).toBeNull()
  })
})
