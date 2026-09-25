import type { JobFailure, JobProgress, JobStatus } from './progress'

// Reads a Smart Tag run (a dataset batch's tag step) for the Jobs drawer:
// GET /api/smart-tag/progress. The backend may queue a run behind other AI
// work; such a run gets its job id when it starts. Pure: smartTagDriver.ts polls.

/** What the drawer knows about one Smart Tag run. */
export interface SmartTagContext {
  /** Our run's job id, when the start gave one. */
  jobId?: string
  /** Our place in the AI queue while the run waits. */
  queueId?: string
}

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])

const STATUS: Record<string, JobStatus> = {
  queued: 'queued',
  running: 'running',
  completed: 'done',
  done: 'done',
  warning: 'done',
  failed: 'error',
  error: 'error',
  cancelled: 'cancelled',
  idle: 'idle',
}

const waitingIn = (raw: Raw, queueId: string | undefined) =>
  queueId !== undefined && rows(obj(raw.pipeline_queue).queued).some((q) => str(q.queue_id) === queueId)

/** A queued run has started once it left the queue: the active run is then ours. */
export function startedJobId(payload: unknown, queueId: string | undefined): string | null {
  const raw = obj(payload)
  if (waitingIn(raw, queueId) || raw.active !== true) return null
  return str(raw.job_id) || null
}

/** Library images are named by id in the errors, folder images by path. */
function failures(list: unknown): JobFailure[] {
  return rows(list).map((r) => {
    const key = str(r.image_id)
    const id = /^\d+$/.test(key) ? Number(key) : null
    return { id, name: id === null ? key : '', reason: str(r.error) || 'Failed' }
  })
}

/** Smart Tag names its own states; a run still waiting in the AI queue has no job yet. */
export function readSmartTag(base: JobProgress, raw: Raw, ctx: SmartTagContext = {}): JobProgress {
  if (ctx.jobId === undefined && waitingIn(raw, ctx.queueId)) return { ...base, status: 'queued', current: 0, total: 0, currentItem: null, message: '' }
  if (ctx.jobId !== undefined && str(raw.job_id) !== ctx.jobId && str(raw.status) !== 'idle') return { ...base, status: 'error' }
  const status = STATUS[str(raw.status)] ?? 'error'
  const failed = failures(raw.errors)
  return {
    ...base,
    status,
    current: num(raw.processed),
    total: num(raw.total),
    succeeded: num(raw.succeeded),
    failedCount: Math.max(num(raw.failed), failed.length),
    failures: failed,
    message: status === 'error' ? str(raw.message) : '',
  }
}
