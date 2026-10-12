import { art } from '../tools/artist/artistText'
import type { JobProgress, JobStatus } from './progress'

// Reads style (artist) identification for the Jobs drawer: GET
// /api/artists/batch-progress answers a running flag and a step word
// (starting, loading_runtime, identifying, done, error, idle), `processed`
// for identified images and `errors` for failed ones. The backend runs one
// batch at a time and has no "stopped" word: a stopped run ends as done short
// of its total. artistDriver.ts polls.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

const LOADING = new Set(['starting', 'loading_runtime'])

function statusOf(raw: Raw, handled: number, total: number, prev?: JobProgress): JobStatus {
  if (raw.running === true) return prev?.status === 'cancelling' ? 'cancelling' : 'running'
  const step = str(raw.step)
  if (step === 'error') return 'error'
  if (step === 'idle') return 'idle'
  return handled < total ? 'cancelled' : 'done'
}

/** `prev`: the job's last reading (a stop asked for is kept until the backend ends). */
export function readArtist(base: JobProgress, raw: Raw, prev?: JobProgress): JobProgress {
  const processed = num(raw.processed)
  const errors = num(raw.errors)
  const total = num(raw.total)
  const status = statusOf(raw, processed + errors, total, prev)
  const loading = raw.running === true && LOADING.has(str(raw.step))
  return {
    ...base,
    status,
    current: processed + errors,
    total,
    succeeded: processed,
    failedCount: errors,
    currentItem: loading ? art('artist.run.loading') : raw.running === true ? str(raw.current_item) || null : null,
    message: status === 'error' ? str(raw.message) : '',
  }
}
