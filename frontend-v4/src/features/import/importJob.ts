import { api, ApiError, unwrap } from '../../api/client'
import { tailOfPath } from '../../lib/paths'
import { useToasts } from '../../ui/toasts'
import { addJob, isQueueBusy, startingProgress, tr } from '../jobs/jobs'

export interface ImportOptions {
  recursive: boolean
  /** Read generation details of already-imported images again (slower). */
  forceReparse: boolean
  /** Also drop records of files that are gone from this folder. */
  cleanupMissing: boolean
  /** Check every file instead of trusting size and date (slower). */
  verifyFiles: boolean
}

// Shared with V3.5 (same origin), so both apps offer the same recent folders.
const RECENT_KEY = 'sd-image-sorter-recent-folders'
const RECENT_MAX = 5

export function recentImports(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p.length > 0) : []
  } catch {
    return []
  }
}

function rememberImport(path: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...recentImports().filter((p) => p !== path)].slice(0, RECENT_MAX)))
  } catch {
    // storage blocked: the list just won't be remembered
  }
}

type ScanState = { status?: string; run_id?: number; source?: string | null }

const TERMINAL = new Set(['done', 'cancelled', 'error'])

/**
 * Import (scan) `folder`. A finished manual import the other app never
 * acknowledged would block a new one, so it is acknowledged first.
 */
export async function startImport(folder: string, o: ImportOptions): Promise<boolean> {
  if (isQueueBusy('scan')) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return false
  }
  try {
    const before = unwrap<ScanState>(await api.GET('/api/scan/progress'))
    if (before.source === 'manual' && TERMINAL.has(before.status ?? '') && (before.run_id ?? 0) > 0) {
      unwrap(await api.POST('/api/scan/acknowledge', { body: { run_id: before.run_id ?? 0, source: 'manual' } }))
    }
    const res = unwrap<{ run_id: number }>(
      await api.POST('/api/scan', {
        body: {
          folder_path: folder,
          recursive: o.recursive,
          force_reparse: o.forceReparse,
          cleanup_missing: o.cleanupMissing,
          quick_import: !o.verifyFiles,
        },
      }),
    )
    rememberImport(folder)
    addJob({
      kind: 'scan',
      destination: folder,
      label: tailOfPath(folder, 36),
      ctx: { runId: res.run_id },
      progress: { ...startingProgress(0), phase: 'files' },
    })
    return true
  } catch (error) {
    const busy = error instanceof ApiError && error.status === 409
    useToasts.getState().push(busy ? tr('import.busy') : tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  }
}
