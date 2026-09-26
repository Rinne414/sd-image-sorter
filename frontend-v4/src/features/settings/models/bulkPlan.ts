import type { InstallTarget } from '../../jobs/installJob'
import type { BulkItem } from './types'

// "Download models…": which entries of GET /api/models/bulk-bundle can be
// picked, which start ticked, how much the picks download, and the downloads
// they turn into (in the list's order, one at a time).

/** A model can be picked when it is missing and the app can download it. */
export function canPick(item: BulkItem): boolean {
  return item.status !== 'ready' && item.download_supported !== false
}

/** Ticked at first: what the backend preselects, never a model that needs the user's own permission. */
export function initialPicks(items: readonly BulkItem[]): Set<string> {
  return new Set(items.filter((i) => canPick(i) && i.default_selected && !i.requires_auth).map((i) => i.id))
}

export function recommendedPicks(items: readonly BulkItem[]): Set<string> {
  return new Set(items.filter((i) => canPick(i) && i.recommended && !i.requires_auth).map((i) => i.id))
}

/** Everything that can download, the gated model included (the user chose it). */
export function allPicks(items: readonly BulkItem[]): Set<string> {
  return new Set(items.filter(canPick).map((i) => i.id))
}

export function pickedBytes(items: readonly BulkItem[], picks: ReadonlySet<string>): number {
  return items.filter((i) => picks.has(i.id) && canPick(i)).reduce((sum, i) => sum + i.size_bytes, 0)
}

export function pickedTargets(items: readonly BulkItem[], picks: ReadonlySet<string>, nameOf: (id: string) => string): InstallTarget[] {
  return items.filter((i) => picks.has(i.id) && canPick(i)).map((i) => ({ card: i.id, variant: i.variant ?? null, label: nameOf(i.id) }))
}

const MB = 1024 * 1024
const GB = 1024 * MB

/** "446 MB", "2.7 GB": how the sizes read next to a download. */
export function downloadSize(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`
}
