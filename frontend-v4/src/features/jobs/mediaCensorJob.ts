import type { JobFailure, JobProgress, JobStatus } from './progress'

// Reads a GIF / video censor job for the Jobs drawer: GET
// /api/censor/media/jobs/{id} answers { status, files: [{ name, status,
// frames_done, frames_total, censored_frames, output, error }], done, total }.
// The driver (mediaCensorDriver.ts) adds two answers of its own: { gone: true }
// when the backend no longer knows the job (404, it was restarted) and
// { unreachable: true } when the program did not answer this time.
//
// Progress counts in percent: one file is often the whole job, and a GIF
// would otherwise sit at 0 until it ended.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])

export type MediaFileStatus = 'queued' | 'running' | 'done' | 'error' | 'skipped'

export interface MediaFile {
  name: string
  status: MediaFileStatus
  /** Frames the detector found something in (the ones that got covered). */
  censoredFrames: number
  /** The written file; '' until it is finished. */
  output: string
  error: string
}

/** What the drawer shows beyond the generic progress. */
export interface MediaExtras {
  jobId: string
  /** Where the results go. */
  folder: string
  files: MediaFile[]
  filesDone: number
  /** Finished files in which nothing needed covering. */
  untouched: number
  /** The program did not answer the last few looks. */
  unreachable: boolean
}

const FILE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'done', 'error', 'skipped'])

function readFile(raw: Raw): MediaFile {
  const status = str(raw.status)
  return {
    name: str(raw.name),
    status: FILE_STATUSES.has(status) ? (status as MediaFileStatus) : 'queued',
    censoredFrames: num(raw.censored_frames),
    output: str(raw.output),
    error: str(raw.error),
  }
}

/** Share of the whole job that is finished, 0-100: finished files plus the running file's frames. */
export function sharePercent(rawFiles: readonly Raw[]): number {
  if (rawFiles.length === 0) return 0
  let done = 0
  for (const f of rawFiles) {
    const status = str(f.status)
    if (status === 'done' || status === 'error' || status === 'skipped') done += 1
    else if (status === 'running' && num(f.frames_total) > 0) done += Math.min(1, num(f.frames_done) / num(f.frames_total))
  }
  return Math.min(100, Math.floor((done / rawFiles.length) * 100))
}

export interface MediaContext {
  jobId: string
  folder: string
}

function statusOf(raw: Raw, files: readonly MediaFile[], prev: JobProgress | undefined): JobStatus {
  const status = str(raw.status)
  if (status === 'cancelled') return 'cancelled'
  if (status === 'done' || status === 'done_with_errors') {
    // Every file failed: nothing was made, which is a failed job and not a finished one.
    return files.length > 0 && files.every((f) => f.status === 'error') ? 'error' : 'done'
  }
  return prev?.status === 'cancelling' ? 'cancelling' : 'running'
}

export function readMediaCensor(base: JobProgress, raw: Raw, ctx: MediaContext, prev?: JobProgress): JobProgress {
  if (raw.gone === true) return { ...base, status: 'error', lost: true, current: prev?.current ?? 0, total: 100, unit: 'percent', currentItem: null, message: '', ...(prev?.media ? { media: prev.media } : {}) }
  if (raw.unreachable === true && prev) {
    // Even before the first answer (nothing is known of the files yet) the drawer can say so.
    const known: MediaExtras = prev.media ?? { jobId: ctx.jobId, folder: ctx.folder, files: [], filesDone: 0, untouched: 0, unreachable: false }
    return { ...prev, media: { ...known, unreachable: true } }
  }
  const rawFiles = rows(raw.files)
  const files = rawFiles.map(readFile)
  const status = statusOf(raw, files, prev)
  const finished = files.filter((f) => f.status === 'done')
  const failures: JobFailure[] = files.filter((f) => f.status === 'error').map((f) => ({ id: null, name: f.name, reason: f.error || 'Failed' }))
  const running = files.find((f) => f.status === 'running')
  const media: MediaExtras = {
    jobId: ctx.jobId,
    folder: ctx.folder,
    files,
    filesDone: files.filter((f) => f.status === 'done' || f.status === 'error').length,
    untouched: finished.filter((f) => f.censoredFrames === 0).length,
    unreachable: false,
  }
  return {
    ...base,
    status,
    unit: 'percent',
    total: 100,
    current: status === 'done' ? 100 : sharePercent(rawFiles),
    succeeded: finished.length,
    failedCount: failures.length,
    failures,
    currentItem: status === 'running' || status === 'cancelling' ? (running?.name ?? null) : null,
    message: status === 'error' ? (failures[0]?.reason ?? str(raw.error)) : '',
    media,
  }
}
