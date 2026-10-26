import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import { api, unwrap } from '../../../api/client'
import type { Batch } from '../../../api/types'
import { translate, useLang } from '../../../i18n'
import { useApp } from '../../../state/store'
import type { Entry } from '../entries'
import { checkScope, sentKeys } from './checkApi'
import type { QualityAnswer } from './checkIssues'
import type { CheckOptions } from './checkOptions'

// Blur and flat-colour hints. The backend scores the pictures on the CPU as one
// background job and remembers the numbers; this asks, waits for the job (the
// page stays usable: it is only a poll) and asks again for the answer.

/** How often the running job is looked at (ms). */
const POLL_MS = 700
/** Polls that may fail in a row before the check says it failed. */
const MAX_POLL_ERRORS = 5
/** Jobs started one after another for one check (another check's job may be running first). */
const MAX_ROUNDS = 20

export interface QualityProgress {
  done: number
  total: number
}

/** How far the scoring job has got, by batch (null: none running). */
export const useQualityProgress = create<{ byBatch: Record<number, QualityProgress | null> }>(() => ({ byBatch: {} }))

const setProgress = (batchId: number, progress: QualityProgress | null) =>
  useQualityProgress.setState((s) => ({ byBatch: { ...s.byBatch, [batchId]: progress } }))

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

interface JobRaw {
  status: string
  processed: number
  total: number
  error_samples?: string[]
  message?: string
}

/** Polls one bulk job until it ends; throws when it failed or the caller gave up (`signal`). */
async function waitForJob(batchId: number, jobId: string, signal: AbortSignal): Promise<void> {
  let errors = 0
  for (;;) {
    let job: JobRaw | null = null
    try {
      job = unwrap<JobRaw>(await api.GET('/api/bulk-jobs/{job_id}', { params: { path: { job_id: jobId } }, signal }))
      errors = 0
    } catch (error) {
      if (signal.aborted) throw error
      errors += 1
      if (errors >= MAX_POLL_ERRORS) throw error
    }
    if (job) {
      setProgress(batchId, { done: job.processed, total: job.total })
      if (job.status === 'error') throw new Error(job.error_samples?.[0] ?? job.message ?? 'failed')
      if (job.status === 'cancelled') throw new Error(translate(useLang.getState().lang, 'dataset.check.quality.stopped'))
      if (job.status === 'done') return
    }
    await sleep(POLL_MS)
  }
}

/** One question to the backend: what is scored, what still waits, which pictures to look at. */
async function ask(ids: number[], paths: string[], o: CheckOptions, start: boolean, signal: AbortSignal): Promise<QualityAnswer> {
  return unwrap<QualityAnswer>(
    await api.POST('/api/dataset/quality', {
      body: { image_ids: ids, image_paths: paths, start, blur_below: o.blurBelow > 0 ? o.blurBelow : 0 } as never,
      signal,
    }),
  )
}

/** Possibly blurry and very flat pictures across every image (Library and folder), scored in the background. */
export function useImageQuality(batch: Batch, entries: readonly Entry[], o: CheckOptions, run: number) {
  const library = useApp((s) => s.libraryId)
  const { ids, paths } = checkScope(entries)
  return useQuery({
    queryKey: ['check-quality', library, batch.id, run, o.blurBelow],
    enabled: ids.length + paths.length > 0,
    queryFn: async ({ signal }) => {
      try {
        let answer = await ask(ids, paths, o, true, signal)
        for (let round = 0; answer.pending > 0 && answer.job_id && round < MAX_ROUNDS; round += 1) {
          await waitForJob(batch.id, answer.job_id, signal)
          answer = await ask(ids, paths, o, true, signal)
        }
        return { ...answer, sent: sentKeys(entries) }
      } finally {
        setProgress(batch.id, null)
      }
    },
    staleTime: Infinity,
  })
}
