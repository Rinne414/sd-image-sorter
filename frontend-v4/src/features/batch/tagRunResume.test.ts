import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// The app's stores read the address and storage when they load: a bare page for them (tests run in node).
const storage = vi.hoisted(() => {
  const store = new Map<string, string>()
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  }
  const location = { pathname: '/v4/', search: '', hash: '' }
  const window = Object.assign(new EventTarget(), { location })
  Object.assign(globalThis, { window, location, localStorage: fake, sessionStorage: fake })
  return fake
})

import { api } from '../../api/client'
import { driveSmartTag, smartTagJobId } from '../jobs/smartTagDriver'
import { useJobs } from '../jobs/jobs'
import { pendingRun, rememberRun, resumeRun, type PendingRun, type StartedRun } from './tagRunResume'

// A batch run that started out queued, after a reload: it is asked for by its
// place in the AI queue (GET /api/smart-tag/progress?queue_id=), also when it
// started and ended while no page watched.

const queue = (ids: string[]) => ({ total_queued: ids.length, queued: ids.map((queue_id) => ({ queue_id, kind: 'smart' })) })
const job = (status: string, settings: Record<string, unknown> = { queue_id: 'q9', queue_enqueued_at: 'T1' }) => ({
  job_id: 's12', status, active: status === 'running', found: true, queue_id: 'q9', total: 4, processed: 4, succeeded: 4, failed: 0, errors: [], settings,
  pipeline_queue: queue([]),
})

const run: PendingRun = { batchId: 7, jobId: null, queueId: 'q9', enqueuedAt: 'T1', model: 'wd', ranKeys: ['l:1', 'l:2', 'f:a', 'f:b'], merge: 'replace' }

function answer(payload: unknown) {
  return vi.spyOn(api, 'GET').mockResolvedValue({ data: payload, response: new Response(null, { status: 200 }) } as never)
}

describe('a batch run that started out queued, after a reload', () => {
  beforeEach(() => {
    storage.clear()
    useJobs.setState({ jobs: [] })
    rememberRun(run)
  })
  afterEach(() => vi.restoreAllMocks())

  test('it started and ended while no page watched: its folder results are written from the job its queue place names', async () => {
    const get = answer(job('completed'))
    const finish = vi.fn<(r: StartedRun) => Promise<void>>(async () => undefined)
    const lost = vi.fn()

    await resumeRun(run, finish, lost)

    expect(get).toHaveBeenCalledWith('/api/smart-tag/progress', { params: { query: { queue_id: 'q9' } } })
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ batchId: 7, jobId: 's12', merge: 'replace' }))
    expect(lost).not.toHaveBeenCalled()
  })

  test('the backend no longer knows the place: the run is lost, never guessed, and forgotten', async () => {
    answer({ status: 'unknown', found: false, active: false, queue_id: 'q9', pipeline_queue: queue([]) })
    const finish = vi.fn(async () => undefined)
    const lost = vi.fn()

    await resumeRun(run, finish, lost)

    expect(lost).toHaveBeenCalledOnce()
    expect(finish).not.toHaveBeenCalled()
    expect(pendingRun(7)).toBeNull()
  })

  test('the place now names a run queued after the app restarted: lost too', async () => {
    answer(job('completed', { queue_id: 'q9', queue_enqueued_at: 'T5' }))
    const finish = vi.fn(async () => undefined)
    const lost = vi.fn()

    await resumeRun(run, finish, lost)

    expect(lost).toHaveBeenCalledOnce()
    expect(finish).not.toHaveBeenCalled()
  })

  test('it was stopped: nothing to write, nothing lost, and it is forgotten', async () => {
    answer(job('cancelled'))
    const finish = vi.fn(async () => undefined)
    const lost = vi.fn()

    await resumeRun(run, finish, lost)

    expect(finish).not.toHaveBeenCalled()
    expect(lost).not.toHaveBeenCalled()
    expect(pendingRun(7)).toBeNull()
  })

  test('still waiting: the drawer follows it by its queue place, and learns its job id once it started', async () => {
    const get = answer({ status: 'queued', found: true, active: false, queue_id: 'q9', pipeline_queue: queue(['q9']) })
    const finish = vi.fn(async () => undefined)

    await resumeRun(run, finish)

    const drawerJob = useJobs.getState().jobs[0]!
    expect(drawerJob).toMatchObject({ kind: 'smarttag', count: 4, ctx: { smartTag: { queueId: 'q9', enqueuedAt: 'T1' } } })
    expect(drawerJob.progress.status).toBe('queued')
    expect(pendingRun(7)).not.toBeNull()

    // it starts: the next poll asks by the queue place and the backend names the job
    get.mockResolvedValue({ data: job('running'), response: new Response(null, { status: 200 }) } as never)
    await driveSmartTag.poll(drawerJob)
    expect(get).toHaveBeenLastCalledWith('/api/smart-tag/progress', { params: { query: { queue_id: 'q9' } } })
    expect(smartTagJobId(drawerJob)).toBe('s12')
    // from then on it is asked for by that job id
    await driveSmartTag.poll(drawerJob)
    expect(get).toHaveBeenLastCalledWith('/api/smart-tag/progress', { params: { query: { job_id: 's12' } } })
  })
})
