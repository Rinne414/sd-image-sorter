import type { JobProgress } from './progress'

// Reads the metadata repair job for the Jobs drawer: POST /api/metadata/reparse
// runs as a bulk job, GET /api/bulk-jobs/{id}. Scope "missing_prompt"
// (kind reparse) recovers missing text; scope "metadata_error" (kind reread)
// re-reads files whose generation details failed to read. Pure: reparseDriver.ts polls.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})

export function readReparse(base: JobProgress, raw: Raw, jobId?: string): JobProgress {
  if (jobId !== undefined && str(raw.job_id) !== jobId) return { ...base, status: 'error' }
  const result = obj(raw.result)
  const reread = str(result.scope) === 'metadata_error'
  return {
    ...base,
    status: str(raw.status) === 'queued' ? 'queued' : base.status,
    current: num(raw.processed),
    total: num(raw.total),
    // A caption found beside an image is text found, as much as a prompt is.
    succeeded: reread ? num(result.fixed) : num(result.recovered) + num(result.captions_recovered),
    failedCount: reread ? num(result.still_error) + num(result.unreadable) : num(raw.error_count),
  }
}
