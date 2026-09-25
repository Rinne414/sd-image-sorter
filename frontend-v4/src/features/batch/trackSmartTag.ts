import { addJob, startingProgress, useJobs } from '../jobs/jobs'
import { smartTagJobId } from '../jobs/smartTagDriver'

// A dataset batch's Smart Tag run in the Jobs drawer. The backend may queue
// it behind other AI work; the drawer follows it by job id once it has one.

export interface SmartTagTrack {
  count: number
  jobId: string | null
  queueId: string | null
  queued: boolean
  /** Runs once the run ended well, with its job id. */
  then: (jobId: string) => void | Promise<void>
}

export function trackSmartTagJob(t: SmartTagTrack): void {
  addJob({
    kind: 'smarttag',
    count: t.count,
    ctx: { smartTag: { jobId: t.jobId ?? undefined, queueId: t.queueId ?? undefined } },
    progress: startingProgress(t.count, t.queued ? 'queued' : 'running'),
    then: (job) => {
      // A queued run learns its job id while it is polled: read the job as it is now.
      const latest = useJobs.getState().jobs.find((j) => j.id === job.id) ?? job
      const id = smartTagJobId(latest)
      if (id) return t.then(id)
    },
  })
}
