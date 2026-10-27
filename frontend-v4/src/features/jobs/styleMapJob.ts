import { translate, useLang } from '../../i18n'
import type { JobProgress, JobStatus } from './progress'

// Reads the Style Map's index job for the Jobs drawer: GET
// /api/style-map/vectors/progress answers a running flag, a paused flag and a
// step word (queued, loading_runtime, extracting, done, cancelled, error,
// idle), `processed` of `total`, `written` vectors and `errors`.
// styleMapDriver.ts polls, pauses, resumes and stops it.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

const ENDED: Record<string, JobStatus> = { done: 'done', cancelled: 'cancelled', error: 'error', idle: 'done' }

function statusOf(raw: Raw, prev?: JobProgress): JobStatus {
  if (raw.running === true) return prev?.status === 'cancelling' ? 'cancelling' : 'running'
  return ENDED[str(raw.step)] ?? 'done'
}

/** `prev`: the job's last reading (a stop asked for is kept until the backend ends). */
export function readStyleMap(base: JobProgress, raw: Raw, prev?: JobProgress): JobProgress {
  const status = statusOf(raw, prev)
  const running = raw.running === true
  const paused = running && raw.paused === true
  const lang = useLang.getState().lang
  const loading = running && (str(raw.step) === 'loading_runtime' || str(raw.step) === 'queued')
  const item = paused ? translate(lang, 'stylemap.job.pausedItem') : loading ? translate(lang, 'stylemap.job.loading') : running ? str(raw.current_item) || null : null
  return {
    ...base,
    status,
    current: num(raw.processed),
    total: num(raw.total),
    succeeded: num(raw.written),
    failedCount: num(raw.errors),
    paused,
    currentItem: item,
    message: status === 'error' ? str(raw.message) : '',
  }
}
