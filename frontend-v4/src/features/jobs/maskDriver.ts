import { api, unwrap } from '../../api/client'
import type { Job } from './jobs'

// Polls and stops "auto-mask all" for the Jobs drawer (read by maskJob.ts).

const jobIdOf = (job?: Job) => job?.ctx.maskJobId ?? ''

export const driveMasks = {
  poll: async (job?: Job): Promise<unknown> => unwrap(await api.GET('/api/bulk-jobs/{job_id}', { params: { path: { job_id: jobIdOf(job) } } })),
  cancel: async (job: Job): Promise<unknown> => unwrap(await api.POST('/api/bulk-jobs/{job_id}/cancel', { params: { path: { job_id: jobIdOf(job) } } })),
}
