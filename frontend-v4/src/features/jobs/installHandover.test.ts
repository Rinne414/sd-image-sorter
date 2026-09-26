import { describe, expect, test } from 'vitest'
import { readProgress, type JobProgress } from './progress'

// A tab following model downloads can miss the moment one run hands over to
// the next: its last look saw its own run downloading, its next look already
// sees the next run (GET /api/models/download-progress). The backend runs one
// prepare at a time and numbers them, so by then ours is over, and its result
// is kept by run id in `finished_prepares`.

/** Read a sequence of polls for one install job, as pollOne does (each reading is the next one's prev). */
function follow(polls: unknown[], installRun: number, modelId = 'clip'): JobProgress[] {
  const seen: JobProgress[] = []
  for (const payload of polls) seen.push(readProgress('install', payload, { modelId, installRun }, seen.at(-1)))
  return seen
}

type Result = Record<string, unknown>

const downloading = (run: number, model: string, downloaded: number, total: number, finished: Record<string, Result> = {}) => ({
  active: true,
  downloaded,
  total,
  filename: `${model}.onnx`,
  prepare_result: { active: true, run_id: run, model_id: model, status: 'downloading' },
  finished_prepares: finished,
})
const ended = (run: number, model: string, fields: Result = {}): Result => ({
  active: false,
  run_id: run,
  model_id: model,
  status: 'done',
  message: '',
  error: '',
  restart_recommended: false,
  ...fields,
})
const settled = (run: number, model: string, fields: Result = {}, finished: Record<string, Result> = {}) => ({
  active: false,
  downloaded: 0,
  total: 0,
  filename: '',
  prepare_result: ended(run, model, fields),
  finished_prepares: finished,
})

describe('an install job that missed the hand-over to the next model', () => {
  test('ends with its own result once the next model is being prepared, and never shows that one’s bytes', () => {
    const polls = [
      downloading(5, 'clip', 300, 600),
      downloading(6, 'artist', 50, 2800, { '5': ended(5, 'clip', { status: 'error', error: 'HTTP 403' }) }),
    ]
    const seen = follow(polls, 5)
    expect(seen[0]).toMatchObject({ status: 'running', current: 300, total: 600, currentItem: 'clip.onnx' })
    expect(seen[1]).toMatchObject({ status: 'error', message: 'HTTP 403' })
    expect(seen[1]!.current).not.toBe(50)
    expect(seen[1]!.currentItem).not.toBe('artist.onnx')
  })

  test('ends with its own result when the next model has already finished too', () => {
    const polls = [
      downloading(5, 'clip', 300, 600),
      settled(6, 'artist', {}, { '5': ended(5, 'clip', { status: 'needs_restart', message: 'Restart to finish.' }), '6': ended(6, 'artist') }),
    ]
    expect(follow(polls, 5)[1]).toMatchObject({ status: 'done', needsRestart: true, restartAdvised: false, message: 'Restart to finish.' })
  })

  test('a run usable now whose restart is only advised stays done without blocking', () => {
    const polls = [downloading(6, 'artist', 1, 2), settled(6, 'artist', {}, { '5': ended(5, 'clip', { restart_recommended: true }) })]
    expect(follow(polls, 5)[1]).toMatchObject({ status: 'done', needsRestart: false, restartAdvised: true })
  })

  test('a run the backend no longer knows ended as lost: an error, not a job that runs forever', () => {
    // older than the results the backend keeps
    const seen = follow([downloading(5, 'clip', 300, 600), downloading(40, 'artist', 50, 2800)], 5)
    expect(seen[1]).toMatchObject({ status: 'error', lost: true, current: 0, currentItem: null })
    // the app restarted: run ids start again and nothing is kept
    const restarted = { active: false, downloaded: 0, total: 0, prepare_result: { active: false, run_id: 0, model_id: '', status: '' }, finished_prepares: {} }
    expect(follow([restarted], 5)[0]).toMatchObject({ status: 'error', lost: true })
  })
})

describe('an install job following its own run', () => {
  test('bytes while its run downloads, then that run’s result', () => {
    const seen = follow([downloading(5, 'clip', 100, 400), settled(5, 'clip', { message: 'Ready.' }, { '5': ended(5, 'clip', { message: 'Ready.' }) })], 5)
    expect(seen[0]).toMatchObject({ status: 'running', current: 100, total: 400, unit: 'bytes' })
    expect(seen[1]).toMatchObject({ status: 'done', needsRestart: false, message: 'Ready.' })
    expect(seen[1]!.lost).toBeFalsy()
  })
})
