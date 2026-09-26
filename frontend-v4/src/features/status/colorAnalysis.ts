import { useQuery } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { addJob, isQueueBusy, startingProgress, tr, type Job } from '../jobs/jobs'
import { busyText } from '../jobs/busyText'

/** The most one run takes (the backend refuses more); runs follow each other until none are left. */
const MAX_PER_RUN = 50_000

const fetchMissing = async (signal?: AbortSignal) =>
  unwrap<{ missing: number; total: number }>(await api.GET('/api/colors/missing-count', { signal }))

/** How many images have no colour analysis yet. */
export function useColorsMissing() {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['colors-missing', libraryId],
    queryFn: ({ signal }) => fetchMissing(signal),
    staleTime: 60_000,
  })
}

/** Start colour analysis of every image that lacks it. False (with the reason said) when it did not start. */
export async function startColorAnalysis(): Promise<boolean> {
  if (isQueueBusy('colors')) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return false
  }
  try {
    const res = unwrap<{ total?: number }>(await api.POST('/api/colors/analyze', { body: { limit: MAX_PER_RUN } }))
    const total = res.total ?? 0
    if (total === 0) {
      void queryClient.invalidateQueries({ queryKey: ['colors-missing'] })
      useToasts.getState().push(tr('status.colorsNothing'), 'info')
      return false
    }
    addJob({ kind: 'colors', count: total, progress: startingProgress(total), then: continueIfMore })
    return true
  } catch (error) {
    const busy = error instanceof ApiError && error.status === 409
    useToasts.getState().push(busy ? busyText(error) : tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  }
}

/** A finished run hands over to the next while images are left, unless the run got nowhere. */
async function continueIfMore(done: Job): Promise<void> {
  if (done.progress.succeeded === 0) return
  try {
    const { missing } = await fetchMissing()
    if (missing > 0) await startColorAnalysis()
  } catch {
    // the status row still shows what is left; the user can start again
  }
}
