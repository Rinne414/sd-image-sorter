import type { BatchItem } from '../../api/types'
import { useToasts } from '../../ui/toasts'
import { isQueueBusy, tr } from '../jobs/jobs'
import { isNoAdjust } from './adjust'
import { resetAdjustDraft } from './adjustDraft'
import { runJob } from './detectAll'
import { applyChange } from './detectRun'
import { appendBase, newOpId, type AdjustValues } from './ops'

// Applying the Adjust tab's filters: to the image open in the editor (one
// undo step, saved when the image is left), or to several images as a job
// that saves each copy as it goes. Each image gets its own adjust op, which
// goes after its earlier picture edits and before any censoring.

const toast = (text: string, kind: 'info' | 'error' = 'info') => useToasts.getState().push(text, kind)

const addAdjust = (batchId: number, item: BatchItem, values: AdjustValues) =>
  applyChange(batchId, item, (ops) => appendBase(ops, { type: 'adjust', id: newOpId(), values: { ...values } }), false)

export async function applyAdjustHere(batchId: number, item: BatchItem, values: AdjustValues): Promise<void> {
  if (isNoAdjust(values)) return void toast(tr('censor.adjust.nothing'))
  await addAdjust(batchId, item, values)
  resetAdjustDraft()
}

export async function applyAdjustTo(batchId: number, items: BatchItem[], values: AdjustValues): Promise<void> {
  if (isNoAdjust(values)) return void toast(tr('censor.adjust.nothing'))
  if (items.length === 0) return
  if (isQueueBusy('adjust')) return void toast(tr('jobs.busy'), 'error')
  const snapshot = { ...values }
  resetAdjustDraft()
  await runJob('adjust', batchId, items, (item) => addAdjust(batchId, item, snapshot))
}
