import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import { api, ApiError, unwrap } from '../../../api/client'
import { useToasts } from '../../../ui/toasts'
import { addJob, isQueueBusy, startingProgress, tr } from '../../jobs/jobs'
import { busyText } from '../../jobs/busyText'
import { pushRefusal } from '../../jobs/refusalToast'
import type { PurityResult } from './checkIssues'

// Character purity (CCIP): is every Library image of the batch the same
// character? Advisory only: it names images, it changes nothing. The model
// (about 150 MB) downloads on first use as a job, then the analysis runs as
// another; the result is kept per batch for this visit.

export interface PurityStatus {
  available: boolean
  preparing: boolean
  default_threshold: number
  prepare_error: string | null
}

export function usePurityStatus() {
  return useQuery({
    queryKey: ['purity-status'],
    queryFn: async ({ signal }) => unwrap<PurityStatus>(await api.GET('/api/dataset/character-purity/status', { signal })),
    staleTime: 30_000,
  })
}

export interface PurityOutcome extends PurityResult {
  threshold: number
  extracted: number
  failed: number
  /** The Library images that were sent. */
  ids: number[]
}

export const usePurityResults = create<{ byBatch: Record<number, PurityOutcome | undefined> }>(() => ({ byBatch: {} }))

const toastError = (error: unknown) => {
  const busy = error instanceof ApiError && error.status === 409
  pushRefusal(busy ? busyText(error) : tr('error.generic', { reason: (error as Error).message }), error)
}

async function keepResult(batchId: number, jobId: string, ids: number[]): Promise<void> {
  const raw = unwrap<{ result?: (PurityResult & { threshold: number; extracted: number; failed: number }) | null }>(
    await api.GET('/api/dataset/character-purity/progress', { params: { query: { job_id: jobId } } }),
  )
  if (!raw.result) return
  const outcome: PurityOutcome = { ...raw.result, ids }
  usePurityResults.setState((s) => ({ byBatch: { ...s.byBatch, [batchId]: outcome } }))
}

async function analyse(batchId: number, ids: number[], threshold: number | null): Promise<boolean> {
  try {
    const res = unwrap<{ job_id: string; total: number }>(
      await api.POST('/api/dataset/character-purity', { body: { image_ids: ids, ...(threshold === null ? {} : { threshold }) } }),
    )
    addJob({
      kind: 'purity',
      count: ids.length,
      ids,
      label: 'CCIP',
      ctx: { purityJobId: res.job_id },
      progress: startingProgress(res.total),
      then: () => keepResult(batchId, res.job_id, ids),
    })
    return true
  } catch (error) {
    toastError(error)
    return false
  }
}

/** Download the model first when it is not there, then analyse these Library images. */
export async function runPurity(batchId: number, ids: number[], threshold: number | null, available: boolean): Promise<boolean> {
  if (isQueueBusy('purity') || isQueueBusy('purityget')) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return false
  }
  if (available) return analyse(batchId, ids, threshold)
  try {
    unwrap(await api.POST('/api/dataset/character-purity/prepare'))
    addJob({
      kind: 'purityget',
      label: 'CCIP',
      progress: { ...startingProgress(0), unit: 'bytes' },
      then: () => void analyse(batchId, ids, threshold),
    })
    return true
  } catch (error) {
    toastError(error)
    return false
  }
}
