import type { JobFailure, JobProgress, JobStatus } from './progress'

// Reads aesthetic scoring for the Jobs drawer. A whole-library run is the
// backend's (GET /api/aesthetic/progress: a running flag, `completed` counting
// failures too, `error` when it crashed). A run over picked images is this
// page's (aestheticDriver.ts) and reports the same shape, plus `cancelled`
// and the failed images. Pure: aestheticDriver.ts polls.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])

function failures(list: unknown): JobFailure[] {
  return rows(list).map((r) => ({ id: typeof r.image_id === 'number' ? r.image_id : null, name: str(r.filename), reason: str(r.error) || 'Failed' }))
}

function statusOf(raw: Raw): JobStatus {
  if (raw.running === true) return raw.cancel_requested === true ? 'cancelling' : 'running'
  if (str(raw.error)) return 'error'
  // The backend has no "stopped" word: a run that ended short of its total was stopped.
  if (raw.cancelled === true || num(raw.completed) < num(raw.total)) return 'cancelled'
  return 'done'
}

export function readAesthetic(base: JobProgress, raw: Raw): JobProgress {
  const completed = num(raw.completed)
  const failed = failures(raw.failed)
  const failedCount = Math.max(num(raw.errors), failed.length)
  return {
    ...base,
    status: statusOf(raw),
    current: completed,
    total: num(raw.total),
    succeeded: Math.max(0, completed - failedCount),
    failedCount,
    failures: failed,
    currentItem: str(raw.current) || null,
    message: str(raw.error),
  }
}
