// Reads the backend's progress payloads for long jobs into one shape.
// move/copy: GET /api/move/progress · trash: GET /api/images/delete-selected/progress
// · remove: GET /api/images/remove-selected/progress · tag: GET /api/tag/progress
// · install: GET /api/models/download-progress · colors: GET /api/colors/progress.

/** tags: a bulk tag edit, finished when it is recorded (kept for its undo). */
export type JobKind = 'move' | 'copy' | 'trash' | 'remove' | 'tag' | 'install' | 'tags' | 'colors'
export type JobStatus = 'queued' | 'running' | 'cancelling' | 'done' | 'cancelled' | 'error' | 'idle'

export interface JobFailure {
  id: number | null
  name: string
  reason: string
}

export interface JobProgress {
  status: JobStatus
  current: number
  total: number
  /** What current/total count. */
  unit: 'images' | 'bytes'
  succeeded: number
  failedCount: number
  failures: JobFailure[]
  /** remove only: rows that were already gone before the job reached them. */
  alreadyGone: number
  /** tag only: the most common tags of the run. */
  topTags: { tag: string; count: number }[]
  /** install only: the model is on disk but the app must restart to use all of it. */
  needsRestart: boolean
  currentItem: string | null
  message: string
}

/** What a reader needs to know about the job it reads for. */
export interface ReadContext {
  /** tag: the run id the backend had before we started; older or equal runs are not ours. */
  baseRunId?: number
  /** install: the model card being prepared. */
  modelId?: string
}

const KNOWN: ReadonlySet<string> = new Set(['running', 'cancelling', 'done', 'cancelled', 'error', 'idle'])

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])
const idOf = (v: unknown) => (typeof v === 'number' ? v : null)

function namedErrors(list: unknown): JobFailure[] {
  return rows(list).map((r) => ({
    id: idOf(r.image_id),
    name: str(r.filename),
    reason: str(r.error) || 'Failed',
  }))
}

function moveFailures(raw: Raw): JobFailure[] {
  const recent = namedErrors(raw.recent_errors)
  const results = rows(raw.results).filter((r) => r.success === false)
  if (!results.length) return recent
  const names = new Map(recent.map((f) => [f.id, f.name]))
  return results.map((r) => {
    const id = idOf(r.id)
    return { id, name: names.get(id) ?? '', reason: str(r.error) || 'Failed' }
  })
}

function readTag(base: JobProgress, raw: Raw, ctx: ReadContext): JobProgress {
  if (ctx.baseRunId !== undefined && num(raw.run_id) <= ctx.baseRunId) {
    // The backend still shows an earlier run: ours is queued or just starting.
    const queued = num(obj(raw.pipeline_queue).total_queued) > 0
    return { ...base, status: queued ? 'queued' : 'running', current: 0, total: 0, currentItem: null, message: '' }
  }
  const topTags = rows(obj(raw.last_run_stats).top_tags)
    .map((r) => ({ tag: str(r.tag), count: num(r.count) }))
    .filter((t) => t.tag)
  return { ...base, succeeded: num(raw.tagged), failedCount: num(raw.errors), topTags }
}

/** Colour analysis reports a running flag instead of a status word. */
function readColors(base: JobProgress, raw: Raw): JobProgress {
  const running = raw.running === true
  const status = running ? (raw.cancel_requested === true ? 'cancelling' : 'running') : 'done'
  const completed = num(raw.completed)
  const failed = num(raw.failed)
  return {
    ...base,
    status,
    current: completed + failed,
    total: num(raw.total),
    succeeded: completed,
    failedCount: failed,
    currentItem: str(raw.current_image) || null,
    message: '',
  }
}

function readInstall(base: JobProgress, raw: Raw, ctx: ReadContext): JobProgress {
  const result = obj(raw.prepare_result)
  const downloading = raw.active === true || result.active === true
  const settled = !downloading && str(result.model_id) === ctx.modelId && str(result.status) !== ''
  if (!settled) {
    return {
      ...base,
      status: 'running',
      unit: 'bytes',
      current: num(raw.downloaded),
      total: num(raw.total),
      currentItem: str(raw.filename) || null,
      message: '',
    }
  }
  const status = str(result.status)
  const message = str(result.message) || str(result.error)
  if (status === 'error') return { ...base, status: 'error', unit: 'bytes', message }
  const needsRestart = result.restart_recommended === true || status === 'needs_restart'
  return { ...base, status: 'done', unit: 'bytes', needsRestart, message }
}

export function readProgress(kind: JobKind, payload: unknown, ctx: ReadContext = {}): JobProgress {
  const raw = obj(payload)
  const status = str(raw.status)
  const base: JobProgress = {
    status: KNOWN.has(status) ? (status as JobStatus) : 'error',
    current: num(raw.current),
    total: num(raw.total),
    unit: 'images',
    succeeded: 0,
    failedCount: 0,
    failures: [],
    alreadyGone: 0,
    topTags: [],
    needsRestart: false,
    currentItem: str(raw.current_item) || null,
    message: str(raw.message),
  }
  switch (kind) {
    case 'move':
    case 'copy': {
      const failures = moveFailures(raw)
      return { ...base, succeeded: num(raw.moved), failures, failedCount: Math.max(num(raw.errors), failures.length) }
    }
    case 'trash': {
      const failures = namedErrors(raw.failed)
      return { ...base, succeeded: num(raw.deleted), failures, failedCount: Math.max(num(raw.errors), failures.length) }
    }
    case 'remove':
      return { ...base, succeeded: num(raw.removed), alreadyGone: Array.isArray(raw.missing_ids) ? raw.missing_ids.length : 0 }
    case 'tag':
      return readTag(base, raw, ctx)
    case 'install':
      return readInstall(base, raw, ctx)
    case 'tags':
      return base
    case 'colors':
      return readColors(base, raw)
  }
}

export function isFinished(status: JobStatus): boolean {
  return status === 'done' || status === 'cancelled' || status === 'error' || status === 'idle'
}
