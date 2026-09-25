// Reads the backend's progress payloads for file jobs into one shape.
// move/copy: GET /api/move/progress · trash: GET /api/images/delete-selected/progress
// · remove: GET /api/images/remove-selected/progress.

export type JobKind = 'move' | 'copy' | 'trash' | 'remove'
export type JobStatus = 'running' | 'cancelling' | 'done' | 'cancelled' | 'error' | 'idle'

export interface JobFailure {
  id: number | null
  name: string
  reason: string
}

export interface JobProgress {
  status: JobStatus
  current: number
  total: number
  succeeded: number
  failedCount: number
  failures: JobFailure[]
  /** remove only: rows that were already gone before the job reached them. */
  alreadyGone: number
  currentItem: string | null
  message: string
}

const KNOWN: ReadonlySet<string> = new Set(['running', 'cancelling', 'done', 'cancelled', 'error', 'idle'])

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
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

export function readProgress(kind: JobKind, payload: unknown): JobProgress {
  const raw: Raw = payload && typeof payload === 'object' ? (payload as Raw) : {}
  const status = str(raw.status)
  const base: JobProgress = {
    status: KNOWN.has(status) ? (status as JobStatus) : 'error',
    current: num(raw.current),
    total: num(raw.total),
    succeeded: 0,
    failedCount: 0,
    failures: [],
    alreadyGone: 0,
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
  }
}

export function isFinished(status: JobStatus): boolean {
  return status === 'done' || status === 'cancelled' || status === 'error' || status === 'idle'
}
