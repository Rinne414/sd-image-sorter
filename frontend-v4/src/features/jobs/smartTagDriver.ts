import { api, unwrap } from '../../api/client'
import type { Job } from './jobs'
import { startedJobId } from './smartTagJob'

// Polls and stops a Smart Tag run for the Jobs drawer (read by smartTagJob.ts).

/** Job ids of runs that started out queued, found once they left the queue (by drawer job id). */
const found = new Map<string, string>()

/** A run's job id: given at the start, or found once it left the queue. */
export const smartTagJobId = (job: Pick<Job, 'id' | 'ctx'>): string | undefined => job.ctx.smartTag?.jobId ?? found.get(job.id)

/** The Jobs drawer's driver for Smart Tag runs. */
export const driveSmartTag = {
  poll: async (job?: Job): Promise<unknown> => {
    const jobId = job ? smartTagJobId(job) : undefined
    const raw = unwrap(await api.GET('/api/smart-tag/progress', { params: { query: jobId ? { job_id: jobId } : {} } }))
    const started = job && !jobId ? startedJobId(raw, job.ctx.smartTag?.queueId) : null
    if (job && started) found.set(job.id, started)
    return raw
  },
  cancel: async (): Promise<unknown> => unwrap(await api.POST('/api/smart-tag/cancel')),
}
