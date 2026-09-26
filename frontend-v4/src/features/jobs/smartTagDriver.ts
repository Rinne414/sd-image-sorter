import { api, unwrap } from '../../api/client'
import type { Job } from './jobs'
import { readProgress } from './progress'
import { DESCRIBE_WORDS, smartTagAdoption, startedJobId } from './smartTagJob'

// Polls and stops a Smart Tag run for the Jobs drawer (read by smartTagJob.ts).

/** Job ids of runs that started out queued, found once they left the queue (by drawer job id). */
const found = new Map<string, string>()

/** A run's job id: given at the start, or found once it left the queue. */
export const smartTagJobId = (job: Pick<Job, 'id' | 'ctx'>): string | undefined => job.ctx.smartTag?.jobId ?? found.get(job.id)

/** A Smart Tag run already going when V4 looked (V3.5, another tab, before a reload), for the drawer. */
export function adoptSmartTag(raw: Record<string, unknown>) {
  const plan = smartTagAdoption(raw)
  if (!plan) return null
  const progress = readProgress('smarttag', raw, plan.ctx)
  return { kind: 'smarttag' as const, progress, ctx: plan.ctx, count: progress.total, ...(plan.describeOnly ? { words: DESCRIBE_WORDS } : {}) }
}

/** The Jobs drawer's driver for Smart Tag runs. */
export const driveSmartTag = {
  poll: async (job?: Job): Promise<unknown> => {
    const jobId = job ? smartTagJobId(job) : undefined
    const queueId = job?.ctx.smartTag?.queueId
    // A run still without a job id is asked for by its queue place: the backend names the job it became.
    const query = jobId ? { job_id: jobId } : queueId ? { queue_id: queueId } : {}
    const raw = unwrap(await api.GET('/api/smart-tag/progress', { params: { query } }))
    const started = job && !jobId ? startedJobId(raw, queueId, job.ctx.smartTag?.enqueuedAt) : null
    if (job && started) found.set(job.id, started)
    return raw
  },
  cancel: async (): Promise<unknown> => unwrap(await api.POST('/api/smart-tag/cancel')),
}
