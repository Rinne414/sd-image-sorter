import { api, unwrap } from '../../api/client'
import { findLoadedImage } from '../../api/loaded'
import { queryClient } from '../../api/queryClient'
import type { BatchSummary, ImageDetailResponse, ImageSummary } from '../../api/types'
import { useLang } from '../../i18n'
import { useApp } from '../../state/store'
import { tr } from '../jobs/jobs'
import { createBatch, patchBatch } from '../batch/batchApi'
import { defaultBatchName } from '../batch/batchLogic'
import { openMediaCensor } from './media/mediaStore'
import { splitPicks } from './media/mediaKind'

// "打码…" from the library (selection bar More, Ctrl K): the picks become a
// custom batch with just pick → censor → export, opened on its censor step.
// GIFs and videos among them cannot be painted on: they go to the GIF and
// video censor (a dialog that starts a job) and the rest goes to the batch.

export const QUICK_STEPS = ['pick', 'censor', 'export'] as const

const LOOKUP_AT_ONCE = 8

function takenNames(): string[] {
  return queryClient
    .getQueriesData<BatchSummary[]>({ queryKey: ['batches'] })
    .flatMap(([, list]) => list ?? [])
    .map((b) => b.name)
}

async function fetchImage(id: number): Promise<ImageSummary | null> {
  try {
    const answer = await queryClient.fetchQuery({
      queryKey: ['image', id],
      queryFn: async () => unwrap<ImageDetailResponse>(await api.GET('/api/images/{image_id}', { params: { path: { image_id: id } } })),
      staleTime: 60_000,
    })
    return answer.image
  } catch {
    return null // unknown: treated as a picture, as before
  }
}

/** What each id is, from the gallery's loaded pages or, for ids it has not loaded, from the backend. */
async function lookupAll(ids: readonly number[]): Promise<Map<number, ImageSummary>> {
  const known = new Map<number, ImageSummary>()
  const missing: number[] = []
  for (const id of ids) {
    const image = findLoadedImage(id)
    if (image) known.set(id, image)
    else missing.push(id)
  }
  for (let i = 0; i < missing.length; i += LOOKUP_AT_ONCE) {
    const chunk = missing.slice(i, i + LOOKUP_AT_ONCE)
    const found = await Promise.all(chunk.map(fetchImage))
    found.forEach((image, at) => {
      const id = chunk[at]
      if (image && id !== undefined) known.set(id, image)
    })
  }
  return known
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
