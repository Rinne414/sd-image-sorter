import type { MessageKey } from '../../i18n'
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

/** A run with the tagger off only describes: the drawer says so instead of "tagging". */
export const DESCRIBE_WORDS: { running: MessageKey; done: MessageKey } = { running: 'dataset.job.describing', done: 'dataset.job.described' }

const LIVE = new Set(['queued', 'running', 'cancelling'])

/**
 * A Smart Tag run that was going before V4 looked (a reload, V3.5, another
 * tab): the drawer follows it by its job id. A run only waiting in the AI
 * queue is left alone: the queue does not say how many images it holds.
 */
export function smartTagAdoption(payload: unknown): { ctx: { smartTag: SmartTagContext & { jobId: string } }; describeOnly: boolean } | null {
  const raw = obj(payload)
  const jobId = str(raw.job_id)
  if (raw.active !== true || !jobId || !LIVE.has(str(raw.status))) return null
  return { ctx: { smartTag: { jobId } }, describeOnly: obj(raw.settings).enable_wd14 === false }
}

/**
 * A remembered batch run that started out queued, read again after a reload
 * (GET /api/smart-tag/progress without a job id). While it waits it is still
 * in the queue. Once it left, the backend does not say which run it became:
 * the active run is taken as ours only if it holds as many images as we sent.
 */
export function queuedRunNow(queueId: string, count: number, payload: unknown): { state: 'waiting' } | { state: 'running'; jobId: string } | { state: 'unknown' } {
  const raw = obj(payload)
  if (waitingIn(raw, queueId)) return { state: 'waiting' }
  const started = startedJobId(raw, queueId)
  return started && num(raw.total) === count ? { state: 'running', jobId: started } : { state: 'unknown' }
}

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
