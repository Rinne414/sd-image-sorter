import { queryClient } from '../../api/queryClient'
import type { BatchSummary } from '../../api/types'
import { useLang } from '../../i18n'
import { useApp } from '../../state/store'
import { tr } from '../jobs/jobs'
import { createBatch, patchBatch } from '../batch/batchApi'
import { defaultBatchName } from '../batch/batchLogic'
import { onlyPictures } from '../video/pictures'

// "打码…" from the library (selection bar More, Ctrl K): the picks become a
// custom batch with just pick → censor → export, opened on its censor step.

export const QUICK_STEPS = ['pick', 'censor', 'export'] as const

function takenNames(): string[] {
  return queryClient
    .getQueriesData<BatchSummary[]>({ queryKey: ['batches'] })
    .flatMap(([, list]) => list ?? [])
    .map((b) => b.name)
}

export async function quickCensor(requested: number[]): Promise<boolean> {
  if (requested.length === 0) return false
  // The censor editor works on pictures: videos are left out, and how many is said.
  const imageIds = await onlyPictures(requested)
  if (imageIds.length === 0) return false
  const name = defaultBatchName(tr('censor.quick.name'), new Date(), useLang.getState().lang, takenNames())
  const batch = await createBatch({ kind: 'custom', name, imageIds })
  if (!batch) return false
  const steps = QUICK_STEPS.map((id) => ({ id, enabled: true }))
  const patched = await patchBatch(batch.id, { steps, current_step: 'censor' }, batch.revision)
  if (!patched) return false
  useApp.getState().openBatch(batch.id)
  return true
}
