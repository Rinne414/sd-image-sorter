import type { JobProgress, JobStatus } from './progress'

// Reads character purity (CCIP) work for the Jobs drawer. The model comes
// through its own download (GET /api/dataset/character-purity/status, not
// the Model Center's), then the analysis runs as one backend job
// (GET /api/dataset/character-purity/progress). Pure: purityDriver.ts polls.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})

/** The model download: running while the backend prepares, done once the files are there. */
export function readPurityDownload(base: JobProgress, raw: Raw): JobProgress {
  const download = obj(raw.download)
  const bytes = { ...base, unit: 'bytes' as const, currentItem: str(download.filename) || null, message: '' }
  const error = str(raw.prepare_error)
  if (error) return { ...bytes, status: 'error', message: error }
  if (raw.preparing === true || download.active === true) {
    return { ...bytes, status: 'running', current: num(download.downloaded), total: num(download.total) }
  }
  if (raw.available === true) return { ...bytes, status: 'done' }
  const missing = Array.isArray(raw.missing_files) ? raw.missing_files.join(', ') : ''
  return { ...bytes, status: 'error', message: missing }
}

const STATUS: Record<string, JobStatus> = {
  starting: 'running',
  running: 'running',
  cancelling: 'cancelling',
  done: 'done',
  cancelled: 'cancelled',
  error: 'error',
  idle: 'idle',
}

/** The analysis: its own job id; images read (extracted) and ones that could not be read (failed). */
export function readPurity(base: JobProgress, raw: Raw, jobId?: string): JobProgress {
  if (jobId !== undefined && str(raw.job_id) !== jobId) return { ...base, status: 'error' }
  const status = STATUS[str(raw.status)] ?? 'error'
  return {
    ...base,
    status,
    current: num(raw.current),
    total: num(raw.total),
    succeeded: num(raw.extracted),
    failedCount: num(raw.failed),
    currentItem: null,
    message: status === 'error' ? str(raw.message) : '',
  }
}
