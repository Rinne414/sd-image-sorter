import { api, unwrap } from '../../api/client'
import type { components } from '../../api/schema'
import { queryClient } from '../../api/queryClient'
import { useToasts } from '../../ui/toasts'
import { addJob, patchJob, setUndoHandler, startingProgress, tr, type Job } from '../jobs/jobs'
import { summarize, type BulkForm, type BulkPath } from './bulkTags'
import { bulkRequest } from './bulkTags'

type Raw = Record<string, unknown>

/**
 * POST one bulk op. The four endpoints share the scope fields; the body was
 * built (and unit-tested) by bulkRequest, and fields it leaves out take the
 * server's defaults, so it is sent as-is rather than re-typed per endpoint.
 */
export async function postBulk(path: BulkPath, body: Record<string, unknown>, signal?: AbortSignal): Promise<Raw> {
  const typed = body as unknown as components['schemas']['BulkAddRequest']
  return unwrap<Raw>(await api.POST(path as '/api/tags/bulk/add', { body: typed, signal }))
}

const WARNINGS = new Set(['undo_journal_truncated', 'undo_journal_persistence_failed'])

/** Apply the edit for real. Records it in the jobs drawer with its undo. False when it failed. */
export async function applyBulk(form: BulkForm, ids: number[]): Promise<boolean> {
  const req = bulkRequest(form, ids, false)
  if (!req) return false
  try {
    const res = await postBulk(req.path, req.body)
    const summary = summarize(form.op, res)
    const opId = typeof res.op_id === 'string' ? res.op_id : null
    const warned = Array.isArray(res.warnings) && res.warnings.some((w) => WARNINGS.has(String((w as Raw).code)))
    addJob({
      kind: 'tags',
      count: ids.length,
      ids,
      progress: { ...startingProgress(ids.length, 'done'), succeeded: summary.images, current: ids.length },
      ...(opId && res.undo_available === true ? { undo: { opId, done: false } } : {}),
    })
    if (warned) useToasts.getState().push(tr('tagedit.undoWarning'), 'error')
    return true
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  }
}

/** Undo requests in flight, so a double click sends one. */
const undoing = new Set<string>()

async function undo(job: Job): Promise<void> {
  if (!job.undo || job.undo.done || undoing.has(job.undo.opId)) return
  undoing.add(job.undo.opId)
  try {
    const res = unwrap<{ restored?: number; skipped_conflicts?: unknown[] }>(
      await api.POST('/api/tags/bulk/undo/{op_id}', { params: { path: { op_id: job.undo.opId } }, body: { force: false } }),
    )
    patchJob(job.id, { undo: { ...job.undo, done: true } })
    for (const key of ['images', 'image', 'suggest']) void queryClient.invalidateQueries({ queryKey: [key] })
    const skipped = Array.isArray(res.skipped_conflicts) ? res.skipped_conflicts.length : 0
    const text = skipped
      ? tr('tagedit.undoneSkipped', { n: res.restored ?? 0, skipped })
      : tr('tagedit.undone', { n: res.restored ?? 0 })
    useToasts.getState().push(text, 'info')
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
  } finally {
    undoing.delete(job.undo.opId)
  }
}

setUndoHandler(undo)
