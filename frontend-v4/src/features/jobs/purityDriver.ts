import { api, unwrap } from '../../api/client'
import type { Job } from './jobs'

// Polls and stops character purity (CCIP) work for the Jobs drawer (read by purityJob.ts).

/** The model download: it cannot be stopped. */
export const drivePurityDownload = {
  poll: async (): Promise<unknown> => unwrap(await api.GET('/api/dataset/character-purity/status')),
  cancel: null,
}

/** The analysis, by the job id its start gave. */
export const drivePurity = {
  poll: async (job?: Job): Promise<unknown> => {
    const jobId = job?.ctx.purityJobId
    return unwrap(await api.GET('/api/dataset/character-purity/progress', { params: { query: jobId ? { job_id: jobId } : {} } }))
  },
  cancel: async (job: Job): Promise<unknown> =>
    unwrap(await api.POST('/api/dataset/character-purity/cancel', { body: job.ctx.purityJobId ? { job_id: job.ctx.purityJobId } : {} })),
}
