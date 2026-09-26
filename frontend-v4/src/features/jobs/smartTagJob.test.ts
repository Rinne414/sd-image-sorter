import { describe, expect, test } from 'vitest'
import { isFinished, readProgress } from './progress'
import { queuedRunAnswer, smartTagAdoption, startedJobId } from './smartTagJob'

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

  test('a queued run is the job the backend says was started from its queue place', () => {
    const queue = (ids: string[]) => ({ total_queued: ids.length, queued: ids.map((queue_id) => ({ queue_id })) })
    const job = (settings: Record<string, unknown>) => ({ job_id: 's7', active: true, status: 'running', settings, pipeline_queue: queue([]) })
    expect(startedJobId({ status: 'queued', found: true, queue_id: 'q3', pipeline_queue: queue(['q3']) }, 'q3')).toBeNull()
    expect(startedJobId(job({ queue_id: 'q3', queue_enqueued_at: 'T1' }), 'q3', 'T1')).toBe('s7')
    // finished before the drawer looked: still ours
    expect(startedJobId({ ...job({ queue_id: 'q3' }), active: false, status: 'completed' }, 'q3')).toBe('s7')
    // another run, or the same place taken again after the app restarted
    expect(startedJobId(job({ queue_id: 'q4' }), 'q3')).toBeNull()
    expect(startedJobId(job({}), 'q3')).toBeNull()
    expect(startedJobId(job({ queue_id: 'q3', queue_enqueued_at: 'T2' }), 'q3', 'T1')).toBeNull()
  })

  test('asked for by its queue place and no longer known: how it ended is lost, never guessed', () => {
    const p = readProgress('smarttag', { status: 'unknown', found: false, queue_id: 'q3', active: false }, { smartTag: { queueId: 'q3' } })
    expect(p).toMatchObject({ status: 'error', lost: true })
  })
})

describe('a Smart Tag run started before V4 looked (a reload, V3.5, another tab)', () => {
  const queue = (ids: string[]) => ({ total_queued: ids.length, queued: ids.map((queue_id) => ({ queue_id, kind: 'smart' })) })

  test('a running one is followed by its job id; a run that only describes says so', () => {
    const raw = { job_id: 'v35', active: true, status: 'running', total: 10, processed: 3, settings: { enable_wd14: true }, pipeline_queue: queue([]) }
    expect(smartTagAdoption(raw)).toEqual({ ctx: { smartTag: { jobId: 'v35' } }, describeOnly: false })
    expect(smartTagAdoption({ ...raw, settings: { enable_wd14: false } })).toEqual({ ctx: { smartTag: { jobId: 'v35' } }, describeOnly: true })
    expect(smartTagAdoption({ ...raw, status: 'cancelling' })?.ctx.smartTag.jobId).toBe('v35')
  })

  test('nothing to follow: idle, finished, or only waiting in the queue (its size is not known)', () => {
    expect(smartTagAdoption({ status: 'idle', active: false, pipeline_queue: queue(['q4']) })).toBeNull()
    expect(smartTagAdoption({ job_id: 'old', active: false, status: 'completed' })).toBeNull()
    expect(smartTagAdoption(null)).toBeNull()
  })
})

describe('a batch tag run that started out queued, looked up by its queue place after a reload', () => {
  const queue = (ids: string[]) => ({ total_queued: ids.length, queued: ids.map((queue_id) => ({ queue_id, kind: 'smart' })) })
  const job = (status: string, extra: Record<string, unknown> = {}) => ({
    job_id: 's12', status, active: status === 'running', found: true, queue_id: 'q9', total: 4,
    settings: { queue_id: 'q9', queue_enqueued_at: 'T1' }, pipeline_queue: queue([]), ...extra,
  })

  test('still waiting in the queue', () => {
    expect(queuedRunAnswer({ status: 'queued', found: true, queue_id: 'q9', pipeline_queue: queue(['q9']) }, 'q9', 'T1')).toEqual({ state: 'waiting' })
  })

  test('running, or finished while no page watched: the job it became', () => {
    expect(queuedRunAnswer(job('running'), 'q9', 'T1')).toEqual({ state: 'running', jobId: 's12' })
    expect(queuedRunAnswer(job('completed'), 'q9', 'T1')).toEqual({ state: 'done', jobId: 's12' })
    expect(queuedRunAnswer(job('warning'), 'q9', 'T1')).toEqual({ state: 'done', jobId: 's12' })
  })

  test('stopped, failed, or could not start: it ended without results', () => {
    expect(queuedRunAnswer(job('cancelled'), 'q9', 'T1')).toEqual({ state: 'ended' })
    expect(queuedRunAnswer(job('failed'), 'q9', 'T1')).toEqual({ state: 'ended' })
    expect(queuedRunAnswer({ status: 'failed', found: true, queue_id: 'q9', message: 'x', pipeline_queue: queue([]) }, 'q9', 'T1')).toEqual({ state: 'ended' })
  })

  test('the backend no longer knows it, or the place now names another run: lost', () => {
    expect(queuedRunAnswer({ status: 'unknown', found: false, queue_id: 'q9', pipeline_queue: queue([]) }, 'q9', 'T1')).toEqual({ state: 'lost' })
    expect(queuedRunAnswer(job('completed', { settings: { queue_id: 'q9', queue_enqueued_at: 'T5' } }), 'q9', 'T1')).toEqual({ state: 'lost' })
  })
})
