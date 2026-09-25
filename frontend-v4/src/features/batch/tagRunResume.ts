import { api, unwrap } from '../../api/client'
import { isQueueBusy, patchJob, useJobs } from '../jobs/jobs'
import { isFinished, readProgress } from '../jobs/progress'
import { smartTagJobId } from '../jobs/smartTagDriver'
import { trackSmartTagJob } from './trackSmartTag'

// A tag run outlives a reload: its job id is kept until its folder results
// are written, and opening the batch's tag step again finishes the work.

const KEY = 'sd-v4-dataset-tag-runs'

export interface PendingRun {
  batchId: number
  jobId: string
  model: string
  ranKeys: string[]
}

const isPending = (v: unknown): v is PendingRun => {
  const r = v as PendingRun
  return !!r && typeof r.batchId === 'number' && typeof r.jobId === 'string' && typeof r.model === 'string' && Array.isArray(r.ranKeys)
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

export function forgetRun(jobId: string): void {
  save(load().filter((r) => r.jobId !== jobId))
}

export const pendingRun = (batchId: number): PendingRun | null => load().find((r) => r.batchId === batchId) ?? null

/**
 * A run this page no longer follows (the page was reloaded): hand its end to
 * `finish` whether it is still running, finished meanwhile, or already
 * picked up by the Jobs drawer. A run that failed or is gone is forgotten.
 */
export async function resumeRun(run: PendingRun, finish: (run: PendingRun) => Promise<void>): Promise<void> {
  const then = () => finish(run)
  const live = useJobs.getState().jobs.find((j) => j.kind === 'smarttag' && smartTagJobId(j) === run.jobId)
  if (live) {
    if (!isFinished(live.progress.status)) patchJob(live.id, { then })
    else if (live.progress.status === 'done') void then()
    else forgetRun(run.jobId)
    return
  }
  try {
    const raw = unwrap(await api.GET('/api/smart-tag/progress', { params: { query: { job_id: run.jobId } } }))
    const progress = readProgress('smarttag', raw, { smartTag: { jobId: run.jobId } })
    if (progress.status === 'done') void then()
    else if (!isFinished(progress.status) && !isQueueBusy('smarttag')) trackSmartTagJob({ count: progress.total, jobId: run.jobId, queueId: null, queued: false, then })
    else if (isFinished(progress.status)) forgetRun(run.jobId)
  } catch {
    // unreachable for now: the next visit tries again
  }
}
