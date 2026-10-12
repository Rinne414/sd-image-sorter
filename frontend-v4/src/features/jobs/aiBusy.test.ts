import { describe, expect, test } from 'vitest'
import type { Job } from './jobs'
import type { JobProgress } from './progress'
import {
  clock,
  holdersOf,
  leaseWork,
  LINGER_MS,
  observe,
  pollDelay,
  readSnapshot,
  readTagRun,
  shortName,
  spoken,
  tagStartPlan,
  track,
  unclaimed,
  workName,
} from './aiBusy'
import { zhCN } from '../../i18n/zh-CN'
import { en } from '../../i18n/en'

const fill = (template: string, params?: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (params?.[k] === undefined ? m : String(params[k])))
const tZh = (key: keyof typeof zhCN, params?: Record<string, string | number>) => fill(zhCN[key], params)
const tEn = (key: keyof typeof en, params?: Record<string, string | number>) => fill(en[key], params)

const running = (total: number): JobProgress => ({
  status: 'running', current: 0, total, unit: 'images', succeeded: 0, failedCount: 0, failures: [], alreadyGone: 0,
  topTags: [], needsRestart: false, restartAdvised: false, toReview: 0, phase: null, updated: 0, currentItem: null, message: '',
})

function job(fields: Partial<Job> & Pick<Job, 'kind'>): Job {
  return {
    id: `${fields.kind}-1`,
    count: 2,
    destination: null,
    ids: [],
    adopted: false,
    pollErrors: 0,
    ctx: {},
    label: null,
    progress: running(2),
    ...fields,
  }
}

const lease = (label: string, elapsed: number, stuck = false) => ({ label, tier: 'vram', elapsed_seconds: elapsed, stuck, estimated_vram_mb: null })

describe('reading the two sources', () => {
  test('the snapshot keeps each lease with its age and stuck flag; junk reads as nothing', () => {
    const s = readSnapshot({ active: 1, stuck_after_seconds: 180, jobs: [{ ...lease('aesthetic', 12.5), estimated_vram_mb: 900 }] })
    expect(s.leases).toEqual([{ label: 'aesthetic', elapsedSeconds: 12.5, stuck: false, vramMb: 900 }])
    expect(readSnapshot(null).leases).toEqual([])
    expect(readSnapshot({ jobs: 'x' }).leases).toEqual([])
  })

  test('the tagging run: running or stopping, on which device, how far, and the gallery runs waiting', () => {
    const r = readTagRun({ status: 'running', run_id: 8, current: 30, total: 120, runtime_backend_actual: 'gpu', pipeline_queue: { total_queued: 3, queued: [{ queue_id: 'q1' }] } })
    expect(r).toEqual({ runId: 8, running: true, device: 'gpu', current: 30, total: 120, queued: 1, model: null })
    expect(readTagRun({ status: 'cancelling', run_id: 2, runtime_backend_target: 'cpu' })).toMatchObject({ running: true, device: 'cpu' })
    expect(readTagRun({ status: 'done', run_id: 8 }).running).toBe(false)
  })
})

describe('naming the work', () => {
  test('backend lease labels become work and model; a tagger being loaded names the tagger', () => {
    expect(leaseWork('tagger-load:wd-eva02-large-tagger-v3')).toEqual({ work: 'tag', model: 'WD EVA02 Large v3', loading: true })
    expect(leaseWork('wd14-tagger')).toEqual({ work: 'tag', model: null, loading: false })
    expect(leaseWork('censor-onnx-inference')).toEqual({ work: 'censor', model: 'YOLO', loading: false })
    expect(leaseWork('nudenet-load')).toEqual({ work: 'censor', model: 'NudeNet', loading: true })
    expect(leaseWork('clip-text-inference').work).toBe('textSearch')
    expect(leaseWork('clip-similarity-inference')).toMatchObject({ work: 'similar', model: 'CLIP' })
    expect(leaseWork('sam3-inference').work).toBe('refine')
    expect(leaseWork('something-new')).toEqual({ work: 'other', model: null, loading: false })
  })

  test('the name says the work, the model and whether it is loading, in both languages', () => {
    expect(workName({ work: 'tag', model: 'PixAI v1.0', loading: false }, tZh)).toBe('打标签 · PixAI v1.0')
    expect(workName({ work: 'tag', model: 'WD EVA02 Large v3', loading: true }, tEn)).toBe('Tagging · WD EVA02 Large v3 (loading the model)')
    expect(workName({ work: 'censor', model: null, loading: false }, tEn)).toBe('Censor detection')
    // the chip has little room: the model when known, else the work
    expect(shortName({ work: 'tag', model: 'PixAI v1.0', loading: true }, tEn)).toBe('PixAI v1.0')
    expect(shortName({ work: 'tag', model: null, loading: false }, tZh)).toBe('打标签')
  })

  test('durations: a clock for the chip, words for sentences', () => {
    expect(clock(7)).toBe('0:07')
    expect(clock(724)).toBe('12:04')
    expect(clock(3723)).toBe('1:02:03')
    expect(spoken(42, tZh)).toBe('42 秒')
    expect(spoken(600, tEn)).toBe('10 min')
    expect(spoken(2 * 3600 + 5 * 60, tZh)).toBe('2 小时 5 分钟')
  })
})

describe('who holds the AI', () => {
  const snapshot = (...leases: ReturnType<typeof lease>[]) => readSnapshot({ jobs: leases })
  const run = (runId: number, extra: Record<string, unknown> = {}) => readTagRun({ status: 'running', run_id: runId, current: 3, total: 10, runtime_backend_actual: 'gpu', ...extra })

  test('a tagging run this page started carries its tagger; leases of one kind of work count once', () => {
    const ours = job({ kind: 'tag', label: 'PixAI v1.0', ctx: { baseRunId: 7 } })
    const obs = observe(snapshot(lease('censor-onnx-inference', 4), lease('censor-onnx-load', 9, true)), run(8), [ours])
    expect(obs).toHaveLength(2)
    expect(obs[0]).toMatchObject({ key: 'run:8', work: 'tag', model: 'PixAI v1.0', device: 'gpu', progress: { current: 3, total: 10 }, jobId: ours.id })
    expect(obs[1]).toMatchObject({ key: 'lease:censor', model: 'YOLO', loading: false, stuck: true, seconds: 9, jobId: null })
  })

  test('a run started elsewhere (V3.5, another window) is named by the tagger the progress reports', () => {
    expect(readTagRun({ status: 'running', run_id: 3, model: 'wd-swinv2-tagger-v3' }).model).toBe('wd-swinv2-tagger-v3')
    expect(readTagRun({ status: 'running', run_id: 3, model: '' }).model).toBeNull()
    expect(observe(null, run(8, { model: 'wd-swinv2-tagger-v3' }), [])[0]).toMatchObject({ model: 'WD SwinV2 v3', jobId: null })
    expect(observe(null, run(8, { model: 'my-own-tagger' }), [])[0]).toMatchObject({ model: 'my-own-tagger' })
    // a drawer job's own label still wins
    const ours = job({ kind: 'tag', label: 'PixAI v1.0', ctx: { baseRunId: 7 } })
    expect(observe(null, run(8, { model: 'wd-swinv2-tagger-v3' }), [ours])[0]).toMatchObject({ model: 'PixAI v1.0' })
  })

  test('a run that is not the one a drawer job waits for is not given that job', () => {
    const later = job({ kind: 'tag', label: 'PixAI v1.0', ctx: { baseRunId: 8 } })
    expect(observe(null, run(8), [later])[0]).toMatchObject({ model: null, jobId: null })
  })

  test('elapsed time spans the gaps between batches; work seen on the first look is "at least"', () => {
    const t0 = 1_000_000
    let seen = track({}, observe(snapshot(lease('aesthetic', 20)), null, []), t0, true)
    expect(holdersOf(seen, t0)[0]).toMatchObject({ seconds: 20, atLeast: true })
    // between two batches the lease is gone for a moment: the same work goes on
    seen = track(seen, [], t0 + 2000, false)
    expect(holdersOf(seen, t0 + 2000)).toHaveLength(1)
    seen = track(seen, observe(snapshot(lease('aesthetic', 1)), null, []), t0 + 4000, false)
    expect(holdersOf(seen, t0 + 4000)[0]).toMatchObject({ seconds: 24, atLeast: true })
    // gone for longer than the linger window: the chip clears
    seen = track(seen, [], t0 + 4000 + LINGER_MS + 1, false)
    expect(holdersOf(seen, t0 + 4000 + LINGER_MS + 1)).toEqual([])
    // work that starts while we watch is timed from when we saw it
    seen = track(seen, observe(null, run(9), []), t0 + 20_000, false)
    expect(holdersOf(seen, t0 + 23_000)[0]).toMatchObject({ key: 'run:9', seconds: 3, atLeast: false })
    // a tagging run that is no longer running has ended: it does not linger
    seen = track(seen, observe(null, readTagRun({ status: 'done', run_id: 9 }), []), t0 + 24_000, false)
    expect(holdersOf(seen, t0 + 24_000)).toEqual([])
    // unless its progress could not be read this time
    seen = track(track(seen, observe(null, run(10), []), t0 + 30_000, false), [], t0 + 31_000, false, false)
    expect(holdersOf(seen, t0 + 31_000)).toHaveLength(1)
  })

  test('stuck work comes first, then a tagging run, then the longest running', () => {
    const t0 = 5_000_000
    const seen = track({}, observe(snapshot(lease('aesthetic', 50), lease('sam3-inference', 400, true)), run(3), []), t0, false)
    expect(holdersOf(seen, t0).map((h) => h.key)).toEqual(['lease:refine', 'run:3', 'lease:aesthetic'])
  })

  test('polls: 1.5 s while busy, 6 s idle, 15 s in a background tab', () => {
    expect(pollDelay(false, true)).toBe(1500)
    expect(pollDelay(false, false)).toBe(6000)
    expect(pollDelay(true, true)).toBe(15000)
  })

  test('work the drawer does not have yet is what makes it look for jobs again', () => {
    const ours = job({ kind: 'tag', ctx: { baseRunId: 7 } })
    expect(unclaimed(observe(null, run(8), []))).toBe('run:8')
    expect(unclaimed(observe(null, run(8), [ours]))).toBe('')
    expect(unclaimed(observe(snapshot(lease('aesthetic', 3), lease('censor-onnx-inference', 3)), null, []))).toBe('lease:aesthetic')
    expect(unclaimed(observe(snapshot(lease('aesthetic', 3)), null, [job({ kind: 'aesthetic' })]))).toBe('')
  })
})

describe('what starting a tagging run does now', () => {
  const t0 = 9_000_000
  const holders = (obs: ReturnType<typeof observe>) => holdersOf(track({}, obs, t0, false), t0)

  test('behind tagging it waits in line; beside other AI work it takes turns; otherwise it just starts', () => {
    const tagging = holders(observe(null, readTagRun({ status: 'running', run_id: 4 }), []))
    expect(tagStartPlan(tagging, false)).toMatchObject({ mode: 'queue', who: { key: 'run:4' } })
    expect(tagStartPlan([], true)).toEqual({ mode: 'queue', who: null })
    const censor = holders(observe(readSnapshot({ jobs: [lease('censor-onnx-inference', 5)] }), null, []))
    expect(tagStartPlan(censor, false)).toMatchObject({ mode: 'share', who: { work: 'censor' } })
    expect(tagStartPlan([], false)).toEqual({ mode: 'free' })
  })
})
