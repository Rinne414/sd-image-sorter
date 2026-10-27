import { api, unwrap } from '../../api/client'
import { loadedImages } from '../../api/loaded'
import { queryClient } from '../../api/queryClient'
import type { BatchSummary, ImageSummary } from '../../api/types'
import { useLang } from '../../i18n'
import { useApp } from '../../state/store'
import { tr } from '../jobs/jobs'
import { createBatch, patchBatch } from '../batch/batchApi'
import { defaultBatchName } from '../batch/batchLogic'
import { lookupRows } from './media/lookupRows'
import { openMediaCensor } from './media/mediaStore'
import { splitPicks } from './media/mediaKind'

// "打码…" from the library (selection bar More, Ctrl K): the picks become a
// custom batch with just pick → censor → export, opened on its censor step.
// GIFs and videos among them cannot be painted on: they go to the GIF and
// video censor (a dialog that starts a job) and the rest goes to the batch.

export const QUICK_STEPS = ['pick', 'censor', 'export'] as const

function takenNames(): string[] {
  return queryClient
    .getQueriesData<BatchSummary[]>({ queryKey: ['batches'] })
    .flatMap(([, list]) => list ?? [])
    .map((b) => b.name)
}

/** Rows of ids the library has not loaded: one request per chunk (file name, path, media type). */
async function fetchRows(chunk: number[]): Promise<ImageSummary[]> {
  return unwrap<{ images: ImageSummary[] }>(await api.POST('/api/images/by-ids', { body: { image_ids: chunk } })).images
}

/** What each id is, from the gallery's loaded pages or, for ids it has not loaded, from the backend. */
function lookupAll(ids: readonly number[]): Promise<Map<number, ImageSummary>> {
  const loaded = loadedImages()
  return lookupRows(ids, (id) => loaded.get(id) ?? null, fetchRows)
}

export async function quickCensor(imageIds: number[]): Promise<boolean> {
  if (imageIds.length === 0) return false
  const known = await lookupAll(imageIds)
  const { pictures, moving } = splitPicks(imageIds, (id) => known.get(id) ?? null)
  if (moving.length > 0) openMediaCensor(moving)
  if (pictures.length === 0) return moving.length > 0
  const name = defaultBatchName(tr('censor.quick.name'), new Date(), useLang.getState().lang, takenNames())
  const batch = await createBatch({ kind: 'custom', name, imageIds: pictures })
  if (!batch) return false
  const steps = QUICK_STEPS.map((id) => ({ id, enabled: true }))
  const patched = await patchBatch(batch.id, { steps, current_step: 'censor' }, batch.revision)
  if (!patched) return false
  useApp.getState().openBatch(batch.id)
  return true
}
