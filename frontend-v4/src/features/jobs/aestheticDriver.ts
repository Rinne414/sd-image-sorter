import { api, ApiError, unwrap } from '../../api/client'
import type { Job } from './jobs'
import { readProgress } from './progress'

// Polls and stops aesthetic scoring for the Jobs drawer (read by aestheticJob.ts).
// A whole-library run is the backend's (POST /api/aesthetic/score-all). Picked
// images are scored here, one request each (POST /api/aesthetic/score/{id}),
// since the backend scores only "all unscored"; that run reports in the
// backend's shape and ends with the page.

interface PageRun {
  total: number
  completed: number
  failed: { image_id: number; error: string }[]
  running: boolean
  stop: boolean
  cancelled: boolean
  error: string | null
}

let pageRun: PageRun | null = null

/** A page run is under way (only one at a time, like the backend's). */
export const isPageRunActive = () => pageRun?.running === true

async function scoreEach(run: PageRun, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    if (run.stop) {
      run.cancelled = true
      break
    }
    try {
      unwrap(await api.POST('/api/aesthetic/score/{image_id}', { params: { path: { image_id: id } } }))
    } catch (error) {
      // The model cannot run at all: every other image would fail the same way.
      if (error instanceof ApiError && error.status === 503) {
        run.error = error.message
        break
      }
      run.failed.push({ image_id: id, error: (error as Error).message })
    }
    run.completed++
  }
  run.running = false
}

/** Score these images in order, from this page. */
export function startPageRun(ids: readonly number[]): void {
  const run: PageRun = { total: ids.length, completed: 0, failed: [], running: true, stop: false, cancelled: false, error: null }
  pageRun = run
  void scoreEach(run, ids)
}

function pageSnapshot(): unknown {
  const run = pageRun
  if (!run) return { running: false, error: 'lost' }
  return {
    running: run.running,
    cancel_requested: run.stop && run.running,
    total: run.total,
    completed: run.completed,
    errors: run.failed.length,
    failed: run.failed,
    cancelled: run.cancelled,
    error: run.error,
  }
}

/** A job over picked images carries their ids; a whole-library run carries none. */
const isPageJob = (job?: Job) => !!job && job.ids.length > 0

export const driveAesthetic = {
  poll: async (job?: Job): Promise<unknown> => (isPageJob(job) ? pageSnapshot() : unwrap(await api.GET('/api/aesthetic/progress'))),
  cancel: async (job: Job): Promise<unknown> => {
    if (!isPageJob(job)) return unwrap(await api.POST('/api/aesthetic/cancel'))
    if (pageRun) pageRun.stop = true
    return null
  },
  liveKeys: ['image'],
}

/** A whole-library run already going when V4 opened (a reload, or V3.5 started it). */
export function adoptAesthetic(raw: Record<string, unknown>) {
  return raw.running === true ? { kind: 'aesthetic' as const, progress: readProgress('aesthetic', raw) } : null
}
