import { api, unwrap } from '../../api/client'
import type { Job } from './jobs'
import { readProgress, type JobKind } from './progress'

// Polls and stops the metadata repair job (recover missing text / re-read
// failed details) for the Jobs drawer (read by reparseJob.ts). The backend
// runs one at a time and names the running one at /api/metadata/reparse-status.

const jobIdOf = (job?: Job) => job?.ctx.reparseJobId ?? ''

type Raw = Record<string, unknown>

export const driveReparse = {
  /** Without a job: the running one, for picking it up after a reload. */
  poll: async (job?: Job): Promise<unknown> => {
    if (!job) return unwrap(await api.GET('/api/metadata/reparse-status'))
    return unwrap(await api.GET('/api/bulk-jobs/{job_id}', { params: { path: { job_id: jobIdOf(job) } } }))
  },
  cancel: async (job: Job): Promise<unknown> =>
    unwrap(await api.POST('/api/bulk-jobs/{job_id}/cancel', { params: { path: { job_id: jobIdOf(job) } } })),
}

/** A repair already running when V4 opened (a reload, or V3.5 started it). */
export function adoptReparse(raw: Raw) {
  const running = raw.job as Raw | null | undefined
  if (raw.active !== true || typeof raw.job_id !== 'string' || !running) return null
  const result = (running.result ?? {}) as Raw
  const kind: JobKind = result.scope === 'metadata_error' ? 'reread' : 'reparse'
  const ctx = { reparseJobId: raw.job_id }
  return { kind, ctx, progress: readProgress(kind, running, ctx) }
}
