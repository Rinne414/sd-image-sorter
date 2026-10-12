import { api, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { Batch, BatchProjectView } from '../../../api/types'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { tr } from '../../jobs/jobs'
import { projectKey } from '../datasetApi'
import type { CaptionContent, HeadInfo } from '../datasetTag'
import { fetchHeads, headsKey } from '../datasetTagApi'
import type { Entry } from '../entries'
import { planOp, type BulkOp, type CategoryOf } from './captionOps'
import type { CaptionSession } from './captionSession'
import { setLastBulk, undoWritten, useLastBulk, writeChanges, type LastBulk, type WriteOutcome } from './bulkApi'

// Running a bulk change: pending single-caption saves go first, the change is
// planned on the captions as the server holds them now, written, and offered
// for undo (the toast, and the panel's button until the next bulk change).

function toast(text: string, tone: 'info' | 'error' = 'info', action?: { label: string; run: () => void }): void {
  useToasts.getState().push(text, tone, action)
}

async function currentHeads(batchId: number): Promise<Map<string, HeadInfo>> {
  const view = await queryClient.fetchQuery({
    queryKey: projectKey(useApp.getState().libraryId, batchId),
    queryFn: async () => unwrap<BatchProjectView>(await api.GET('/api/batches/{batch_id}/project', { params: { path: { batch_id: batchId } } })),
    staleTime: 15_000,
  })
  return queryClient.fetchQuery({
    queryKey: headsKey(useApp.getState().libraryId, view.project.id, view.project.revision),
    queryFn: ({ signal }) => fetchHeads(view, signal),
    staleTime: 15_000,
  })
}

function report(out: WriteOutcome): void {
  if (!out.error) return
  toast(out.refused > 0 ? tr('dataset.bulk.refused', { n: out.refused }) : tr('error.generic', { reason: out.error }), 'error')
}

export interface BulkRequest {
  label: string
  op: BulkOp
  /** The images the change is for (the selection, or every image). */
  keys: readonly string[]
  /** Never-edited images' captions as they start (by entry key). */
  initial: ReadonlyMap<string, CaptionContent>
  entries: ReadonlyMap<string, Entry>
  categoryOf: CategoryOf
}

/** Undo one bulk change (each image as it was); a change is undone once. */
export async function undoBulk(batchId: number, record: LastBulk, entries: ReadonlyMap<string, Entry>): Promise<boolean> {
  if (record.undone) return false
  record.undone = true
  if (useLastBulk.getState().last[batchId] === record) setLastBulk(batchId, null)
  const out = await undoWritten(batchId, record.written, entries)
  report(out)
  if (out.written.length > 0) toast(tr('dataset.bulk.undone', { n: out.written.length }))
  return out.error === null
}

/** Plan and write one bulk change; returns how many captions changed. */
export async function runBulk(batch: Batch, session: CaptionSession, request: BulkRequest): Promise<number> {
  await session.flushAll()
  const heads = await currentHeads(batch.id)
  const contents = new Map(request.initial)
  for (const [key, head] of heads) if (head.content) contents.set(key, head.content)
  const changes = planOp(contents, request.keys, request.op, request.categoryOf)
  if (changes.length === 0) {
    toast(tr('dataset.bulk.nothing'))
    return 0
  }
  const out = await writeChanges(batch.id, changes, request.entries, heads)
  if (out.written.length > 0) {
    const record: LastBulk = { label: request.label, written: out.written, undone: false }
    setLastBulk(batch.id, record)
    toast(tr('dataset.bulk.done', { n: out.written.length, what: request.label }), 'info', {
      label: tr('toast.undo'),
      run: () => void undoBulk(batch.id, record, request.entries),
    })
  }
  report(out)
  return out.written.length
}
