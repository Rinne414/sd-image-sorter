import type { BatchKind, BatchSummary } from '../../api/types'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { Menu, type MenuItem } from '../../ui/Menu'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { useBatches, useBatchTemplates } from './batchApi'
import { addLibraryPicks } from './datasetApi'
import { askNewBatch } from './dialogStore'
import { BATCH_KINDS, kindLabel } from './labels'

/** How many recent batches the menu and Ctrl K offer. */
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

/** "Add to batch ▾" on the selection bar: a new batch of any kind or template, or a recent batch. */
export function AddToBatchMenu() {
  const t = useT()
  const batches = useBatches()
  const templates = useBatchTemplates()
  const picks = () => useApp.getState().selection

  const items: MenuItem[] = [
    ...BATCH_KINDS.map((kind) => ({
      id: `new-${kind}`,
      group: t('batch.menu.new'),
      label: t(`batch.menu.new.${kind}`),
      onSelect: () => askNewBatch(kind, picks(), 'selection'),
    })),
    ...(templates.data?.templates ?? []).map((tpl) => ({
      id: `tpl-${tpl.id}`,
      group: t('batch.menu.templates'),
      label: `${tpl.name}…`,
      hint: kindLabel(tpl.kind, t),
      onSelect: () => askNewBatch(tpl.kind, picks(), 'selection', tpl),
    })),
    ...recentBatches(batches.data).map((batch) => ({
      id: `recent-${batch.id}`,
      group: t('batch.menu.recent'),
      label: batch.name,
      hint: t('rail.images', { n: batch.item_count }),
      onSelect: () => void addPicksTo(batch, picks()),
    })),
  ]

  return <Menu up primary label={t('batch.menu.label')} items={items} testId="add-to-batch" />
}
