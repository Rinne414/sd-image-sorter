import { api, unwrap } from '../../api/client'
import type { MergeStrategy } from '../tagging/tagOptions'
import { isQueueBusy, patchJob, useJobs, type Job } from '../jobs/jobs'
import { isFinished, readProgress } from '../jobs/progress'
import { smartTagJobId } from '../jobs/smartTagDriver'
import { queuedRunNow } from '../jobs/smartTagJob'
import { trackSmartTagJob } from './trackSmartTag'

// A tag run outlives a reload: its job id (or, while it waits in the AI
// queue, its place there) is kept until its folder results are written, and
// opening the batch's tag step again finishes the work.

const KEY = 'sd-v4-dataset-tag-runs'

export interface PendingRun {
  batchId: number
  /** null while the run waits in the AI queue: it gets one when it starts. */
  jobId: string | null
  /** Its place in the AI queue, for a run that started out queued. */
  queueId?: string | null
  model: string
  ranKeys: string[]
  /** How its folder results join the captions (absent in runs kept before it existed: replace). */
  merge?: MergeStrategy
  /** The tagger was off: it only described. */
  describeOnly?: boolean
}

/** A run whose job id is known (the one its results are read by). */
export type StartedRun = PendingRun & { jobId: string }

const isPending = (v: unknown): v is PendingRun => {
  const r = v as PendingRun
  if (!r || typeof r.batchId !== 'number' || typeof r.model !== 'string' || !Array.isArray(r.ranKeys)) return false
  return typeof r.jobId === 'string' || (r.jobId === null && typeof r.queueId === 'string')
}

function load(): PendingRun[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter(isPending) : []
  } catch {
    return []
  }
}

function save(runs: PendingRun[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(runs))
  } catch {
    // storage blocked: a reload mid-run then loses the folder results
  }
}

export function rememberRun(run: PendingRun): void {
  save([...load().filter((r) => r.batchId !== run.batchId), run])
}

/** The batch's run is over (written, failed or gone): nothing is left to finish. */
export function forgetRun(batchId: number): void {
  save(load().filter((r) => r.batchId !== batchId))
}

export const pendingRun = (batchId: number): PendingRun | null => load().find((r) => r.batchId === batchId) ?? null

type Finish = (run: StartedRun) => Promise<void>

/**
 * A run this page no longer follows (the page was reloaded): hand its end to
 * `finish` whether it is still waiting, running, finished meanwhile, or
 * already picked up by the Jobs drawer. A run that failed or is gone is forgotten.
 */
export async function resumeRun(run: PendingRun, finish: Finish): Promise<void> {
  if (run.jobId === null) return resumeQueued(run, finish)
  const started: StartedRun = { ...run, jobId: run.jobId }
  const then = () => finish(started)
  if (followLive(started.jobId, then, run.batchId)) return
  try {
    const raw = unwrap(await api.GET('/api/smart-tag/progress', { params: { query: { job_id: started.jobId } } }))
    const progress = readProgress('smarttag', raw, { smartTag: { jobId: started.jobId } })
    if (progress.status === 'done') void then()
    else if (!isFinished(progress.status) && !isQueueBusy('smarttag')) trackSmartTagJob({ count: progress.total, jobId: started.jobId, queueId: null, queued: false, describeOnly: run.describeOnly, then })
    else if (isFinished(progress.status)) forgetRun(run.batchId)
  } catch {
    // unreachable for now: the next visit tries again
  }
}

/** The drawer already follows this run (adopted, or started before): its end goes to `then`. */
function followLive(jobId: string, then: () => void | Promise<void>, batchId: number): boolean {
  const live = useJobs.getState().jobs.find((j) => j.kind === 'smarttag' && smartTagJobId(j) === jobId)
  if (!live) return false
  if (!isFinished(live.progress.status)) patchJob(live.id, { then })
  else if (live.progress.status === 'done') void then()
  else forgetRun(batchId)
  return true
}

/** A run remembered while it waited in the AI queue: find it again by its place there. */
async function resumeQueued(run: PendingRun, finish: Finish): Promise<void> {
  const count = run.ranKeys.length
  const queueId = run.queueId ?? ''
  const live = useJobs.getState().jobs.find((j) => j.kind === 'smarttag' && j.ctx.smartTag?.queueId === queueId && !isFinished(j.progress.status))
  if (live) return void patchJob(live.id, { then: (job: Job) => endOf(job, run, finish) })
  try {
    const now = queuedRunNow(queueId, count, unwrap(await api.GET('/api/smart-tag/progress')))
    if (now.state === 'unknown') return forgetRun(run.batchId)
    const started = now.state === 'running' ? now.jobId : null
    if (started && followLive(started, () => finish({ ...run, jobId: started }), run.batchId)) return
    trackSmartTagJob({ count, jobId: started, queueId: started ? null : queueId, queued: !started, describeOnly: run.describeOnly, then: (jobId) => finish({ ...run, jobId }) })
  } catch {
    // unreachable for now: the next visit tries again
  }
}

/** A followed queued run ended well: its results are read by the job id it got when it started. */
function endOf(job: Job, run: PendingRun, finish: Finish): void | Promise<void> {
  const latest = useJobs.getState().jobs.find((j) => j.id === job.id) ?? job
  const jobId = smartTagJobId(latest)
  if (jobId) return finish({ ...run, jobId })
}
