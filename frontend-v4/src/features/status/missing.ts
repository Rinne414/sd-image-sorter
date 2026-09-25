import { useQuery } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { addJob, isQueueBusy, startingProgress, tr } from '../jobs/jobs'

// Records whose files are gone: grouped by the folder they claim, found
// again under another folder (a job), reviewed when a found file matches
// several records, or cleared. Nothing here moves or deletes a file.

export type MissingReason = 'file_deleted' | 'folder_deleted' | 'location_unreachable'

export interface MissingGroup {
  location: string
  reason: MissingReason
  clearable: boolean
  count: number
  user_work_total: number
  sample_filenames: string[]
}

export interface MissingSummary {
  total: number
  clearable_total: number
  blocked_total: number
  clearable_user_work_total?: number
  groups: MissingGroup[]
  groups_truncated: boolean
}

export function useMissingGroups() {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['missing-groups', libraryId],
    queryFn: async ({ signal }) => unwrap<MissingSummary>(await api.GET('/api/images/missing-summary', { signal })),
    staleTime: 15_000,
  })
}

export interface ReviewCandidate {
  image_id: number
  path: string
  file_size: number | null
  still_missing: boolean
}

export interface Review {
  review_id: number
  filename: string
  found_path: string
  found_exists: boolean
  candidates: ReviewCandidate[]
}

export function useRepairReviews() {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['repair-candidates', libraryId],
    queryFn: async ({ signal }) =>
      unwrap<{ total: number; items: Review[] }>(
        await api.GET('/api/images/repair-candidates', { params: { query: { status: 'pending', limit: 50, offset: 0 } }, signal }),
      ),
    staleTime: 15_000,
  })
}

const REFRESH = ['images', 'image', 'missing-summary', 'missing-groups', 'repair-candidates', 'library-health', 'folders', 'generators', 'libraries']

function refresh(): void {
  for (const key of REFRESH) void queryClient.invalidateQueries({ queryKey: [key] })
}

const failToast = (error: unknown) => {
  const busy = error instanceof ApiError && error.status === 409
  useToasts.getState().push(busy ? tr('jobs.busy') : tr('error.generic', { reason: (error as Error).message }), 'error')
  return false
}

/** Look for the missing files under `folder` (and its subfolders). */
export async function startReconnect(folder: string): Promise<boolean> {
  if (isQueueBusy('reconnect')) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return false
  }
  try {
    unwrap(await api.POST('/api/images/reconnect-missing/start', { body: { search_folder: folder, recursive: true, verify_uncertain: true } }))
    addJob({ kind: 'reconnect', destination: folder, progress: startingProgress(0) })
    return true
  } catch (error) {
    return failToast(error)
  }
}

/** Drop the records of one folder's missing files (never an unreachable one). */
export async function clearMissing(location: string): Promise<boolean> {
  try {
    const res = unwrap<{ status: string; removed?: number }>(await api.POST('/api/images/missing/clear', { body: { location } }))
    refresh()
    if (res.status === 'refused') {
      useToasts.getState().push(tr('missing.refused'), 'error')
      return false
    }
    useToasts.getState().push(tr('missing.cleared', { n: res.removed ?? 0 }), 'info')
    return true
  } catch (error) {
    return failToast(error)
  }
}

/** Settle one ambiguous match: relink the chosen record to the found file, or leave it. */
export async function settleReview(reviewId: number, chosenImageId: number | null): Promise<boolean> {
  try {
    unwrap(
      await api.POST('/api/images/repair-confirm', {
        body: chosenImageId === null ? { review_id: reviewId, action: 'skip' } : { review_id: reviewId, action: 'pick', chosen_image_id: chosenImageId },
      }),
    )
    refresh()
    return true
  } catch (error) {
    return failToast(error)
  }
}
