import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// The app's stores read the address and storage when they load: a bare page for them (tests run in node).
vi.hoisted(() => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  const location = { pathname: '/v4/', search: '', hash: '' }
  const window = Object.assign(new EventTarget(), {
    location,
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  })
  Object.assign(globalThis, { window, location, localStorage: storage, sessionStorage: storage })
})

import { api } from '../../../api/client'
import { useLang } from '../../../i18n'
import type { TagOptions } from '../../tagging/tagJob'
import { runSmartTag } from './runReverse'

// A vision-model run queued behind other AI work is asked for by its place in
// the AI queue (GET /api/smart-tag/progress?queue_id=), so a run that starts
// and ends between two polls is still found; a place the backend no longer
// knows is said plainly, never guessed.

type Raw = Record<string, unknown>

const JOB = { job_id: 'j1', settings: { queue_id: 'q7', queue_enqueued_at: 'T1' }, found: true, queue_id: 'q7' }
const done = { ...JOB, status: 'completed', active: false, processed: 1, total: 1 }
const empty = { total_queued: 0, queued: [] }

/**
 * The backend: asked by queue place it answers from `byPlace` (one answer per
 * poll, the last one repeating); asked with no place it names only the active
 * run, and none is active here (a run that ended between polls is not active).
 */
function backend(byPlace: Raw[]) {
  let polls = 0
  const res = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) }) as never
  vi.spyOn(api, 'POST').mockImplementation(((path: string) =>
    Promise.resolve(res(path === '/api/smart-tag/start' ? { status: 'queued', pipeline_queued: true, queue_id: 'q7', enqueued_at: 'T1' } : {}))) as never)
  const get = vi.spyOn(api, 'GET').mockImplementation(((path: string, init?: { params?: { query?: Raw } }) => {
    const query = init?.params?.query ?? {}
    if (path === '/api/smart-tag/results') return Promise.resolve(res({ results: [{ caption: 'A girl standing in the rain.', booru_text: '1girl, rain' }] }))
    if (query.queue_id === 'q7') return Promise.resolve(res(byPlace[Math.min(polls++, byPlace.length - 1)]))
    if (query.job_id === 'j1') return Promise.resolve(res(done))
    return Promise.resolve(res({ status: 'idle', active: false, pipeline_queue: empty }))
  }) as never)
  return get
}

const options = { model: 'wd-vit-tagger-v3' } as unknown as TagOptions
const hooks = () => ({ signal: new AbortController().signal, onPhase: vi.fn() })

async function run(): Promise<unknown> {
  const out = runSmartTag('vlm', 'C:/uploads/a.png', '', options, hooks())
  const settled = out.then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.message }),
  )
  await vi.runAllTimersAsync()
  return settled
}

describe('a queued vision-model run of the reverse tool', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useLang.setState({ lang: 'en' })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('it started and finished between two polls: asked by its queue place, its result still shows', async () => {
    const get = backend([done])
    expect(await run()).toEqual({ value: { mode: 'vlm', prompt: 'A girl standing in the rain.', tags: ['1girl', 'rain'] } })
    expect(get).toHaveBeenCalledWith('/api/smart-tag/progress', { params: { query: { queue_id: 'q7' } } })
  })

  test('waiting, then running, then done: followed by its job id once it started', async () => {
    const waiting = { status: 'queued', found: true, active: false, queue_id: 'q7', pipeline_queue: { total_queued: 1, queued: [{ queue_id: 'q7' }] } }
    const get = backend([waiting, waiting, { ...JOB, status: 'running', active: true }])
    expect(await run()).toMatchObject({ value: { prompt: 'A girl standing in the rain.' } })
    expect(get).toHaveBeenLastCalledWith('/api/smart-tag/results', expect.anything())
    expect(get).toHaveBeenCalledWith('/api/smart-tag/progress', { params: { query: { job_id: 'j1' } } })
  })

  test('the backend no longer knows its place: how it ended is not guessed', async () => {
    backend([{ status: 'unknown', found: false, active: false, queue_id: 'q7', pipeline_queue: empty }])
    expect(await run()).toEqual({ error: "We couldn't find how this run ended (it may have been taken out of the queue, or the app restarted). Run it again." })
  })

  test('the place now names a run queued after the app restarted: not ours either', async () => {
    backend([{ ...done, settings: { queue_id: 'q7', queue_enqueued_at: 'T9' } }])
    expect(await run()).toMatchObject({ error: expect.stringContaining("couldn't find how this run ended") })
  })

  test('it could not start: the reason is said', async () => {
    backend([{ status: 'failed', found: true, active: false, queue_id: 'q7', message: 'VLM endpoint missing', pipeline_queue: empty }])
    expect(await run()).toEqual({ error: 'VLM endpoint missing' })
  })
})
