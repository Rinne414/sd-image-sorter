import { create } from 'zustand'
import { api, ApiError, unwrap } from '../../api/client'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { addJob, isQueueBusy, startingProgress, tr } from '../jobs/jobs'

// The two metadata repairs the library status offers (one runs at a time on
// the backend): recover missing text from stored raw metadata and the files,
// and re-read files whose generation details failed to read.

export type RepairKind = 'reparse' | 'reread'

const SCOPE: Record<RepairKind, 'missing_prompt' | 'metadata_error'> = { reparse: 'missing_prompt', reread: 'metadata_error' }

// How many images still had no text when a recovery run last ended, per
// library: another run finds nothing new until that number grows.
const LEFT_KEY = 'sd-v4-text-recovery-left'

function readLeft(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(LEFT_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {}
  } catch {
    return {}
  }
}

export const useTextRecoveryLeft = create<{ byLibrary: Record<string, number> }>(() => ({ byLibrary: readLeft() }))

function rememberLeft(libraryId: string, left: number): void {
  const byLibrary = { ...useTextRecoveryLeft.getState().byLibrary, [libraryId]: left }
  useTextRecoveryLeft.setState({ byLibrary })
  try {
    localStorage.setItem(LEFT_KEY, JSON.stringify(byLibrary))
  } catch {
    // storage blocked: the offer just comes back after a reload
  }
}

/** After a recovery run: note what it could not find (the metadata health count is never cached). */
async function noteWhatIsLeft(libraryId: string): Promise<void> {
  try {
    const health = unwrap<{ totals?: { missing_text?: number } }>(await api.GET('/api/metadata/health'))
    rememberLeft(libraryId, health.totals?.missing_text ?? 0)
  } catch {
    // unknown: keep offering it
  }
}

export async function startRepair(kind: RepairKind, count: number): Promise<boolean> {
  if (isQueueBusy('reparse') || isQueueBusy('reread')) {
    useToasts.getState().push(tr('status.repair.busy'), 'error')
    return false
  }
  const libraryId = useApp.getState().libraryId
  try {
    const res = unwrap<{ job_id: string }>(await api.POST('/api/metadata/reparse', { body: { scope: SCOPE[kind] } }))
    addJob({
      kind,
      count,
      ctx: { reparseJobId: res.job_id },
      progress: startingProgress(count),
      ...(kind === 'reparse' ? { then: () => noteWhatIsLeft(libraryId) } : {}),
    })
    return true
  } catch (error) {
    const busy = error instanceof ApiError && error.status === 409
    useToasts.getState().push(busy ? tr('status.repair.busy') : tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  }
}
