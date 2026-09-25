import type { BatchKind, BatchSummary } from '../../api/types'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { addLibraryPicks } from './datasetApi'

// Adding Library picks to a batch from anywhere (selection actions, Ctrl K).

/** How many recent batches the selection actions and Ctrl K offer. */
export const RECENT_BATCHES = 5

/** Add these images to an existing batch and say what happened, with a way to open it. */
export async function addPicksTo(batch: { id: number; name: string; kind: BatchKind }, ids: number[]): Promise<boolean> {
  const res = await addLibraryPicks(batch, ids)
  if (!res) return false
  const text =
    res.skipped > 0
      ? tr('batch.addedSkipped', { n: res.added, name: batch.name, skipped: res.skipped })
      : tr('batch.added', { n: res.added, name: batch.name })
  useToasts.getState().push(text, 'info', { label: tr('batch.open'), run: () => useApp.getState().openBatch(batch.id) })
  return true
}

/** Recent batches that can take images (a dataset batch whose project was deleted cannot). */
export function recentBatches(batches: BatchSummary[] | undefined, max = RECENT_BATCHES): BatchSummary[] {
  return (batches ?? []).filter((b) => !b.orphaned).slice(0, max)
}
