import type { JobFailure, JobProgress } from './progress'

// Reads "auto-mask all" (POST /api/masks/auto-batch) for the Jobs drawer: a
// bulk job, GET /api/bulk-jobs/{id}. Its result counts saved masks, images
// skipped because they already had one, and the failures. Pure: maskDriver.ts polls.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])

function failures(list: unknown): JobFailure[] {
  return rows(list).map((r) => ({ id: typeof r.image_id === 'number' ? r.image_id : null, name: '', reason: str(r.error) || 'Failed' }))
}

export function readMasks(base: JobProgress, raw: Raw, jobId?: string): JobProgress {
  if (jobId !== undefined && str(raw.job_id) !== jobId) return { ...base, status: 'error' }
  const result = obj(raw.result)
  const failed = failures(result.errors)
  return {
    ...base,
    status: str(raw.status) === 'queued' ? 'queued' : base.status,
    current: num(raw.processed),
    total: num(raw.total),
    succeeded: num(result.saved),
    failedCount: Math.max(num(result.error_count), num(raw.error_count), failed.length),
    failures: failed,
  }
}
