// Duplicate review: the last scan's groups. The scan suggests one keeper
// (best rating, aesthetic, resolution, file size); every other image starts
// ticked for the trash, as in V3.5. The user may tick and untick any, so two
// or more can be kept, but never none: the tick that would leave a group with
// nothing kept is refused. Pure, so what gets removed is tested.

export interface DupMember {
  id: number
  path: string
  filename: string
  width: number | null
  height: number | null
  file_size: number | null
  aesthetic_score: number | null
  user_rating: number | null
  suggested_keep: boolean
}

export interface DupGroup {
  group_id: number
  similarity: number
  members: DupMember[]
}

export interface DupSummary {
  embedded_count: number
  group_count: number
  redundant_count: number
  reclaimable_bytes: number
  threshold: number
  total_images?: number
  pending_count?: number
  coverage?: number
  exact?: boolean
}

export interface DupPage {
  available: boolean
  scanned_at?: number | null
  threshold?: number | null
  summary: DupSummary | null
  groups: DupGroup[]
  total_groups: number
  offset: number
  limit: number
  has_more: boolean
}

/** Scan sensitivity, strictest first (V3.5's three settings). */
export const THRESHOLDS = [0.98, 0.95, 0.9] as const

/** The keeper the scan suggests (else the first member). */
function suggestedKeeper(group: DupGroup): number {
  return (group.members.find((m) => m.suggested_keep) ?? group.members[0])?.id ?? -1
}

/**
 * The members ticked for the trash: the user's ticks (members only), else all
 * but the suggested keeper. Never all of them: ticks saved before members went
 * away leave the suggested keeper out.
 */
export function marksOf(group: DupGroup, ticks: ReadonlySet<number> | undefined): number[] {
  const ids = group.members.map((m) => m.id)
  const keeper = suggestedKeeper(group)
  if (!ticks) return ids.filter((id) => id !== keeper)
  const marked = ids.filter((id) => ticks.has(id))
  return marked.length < ids.length ? marked : marked.filter((id) => id !== keeper)
}

/** Whether this member can be ticked: it is in the group and not the last one kept. */
export function canMark(group: DupGroup, ticks: ReadonlySet<number> | undefined, id: number): boolean {
  const marked = marksOf(group, ticks)
  if (!group.members.some((m) => m.id === id)) return false
  return marked.includes(id) || marked.length + 1 < group.members.length
}

/** Tick or untick one member; a tick that would leave nothing kept changes nothing. */
export function toggleMark(group: DupGroup, ticks: ReadonlySet<number> | undefined, id: number): ReadonlySet<number> {
  const marked = new Set(marksOf(group, ticks))
  if (marked.has(id)) marked.delete(id)
  else if (canMark(group, ticks, id)) marked.add(id)
  else return ticks ?? new Set(marksOf(group, undefined))
  return marked
}

/**
 * The persisted scan does not know what was removed since: keep only members
 * that still exist, and only groups that still have two of them.
 */
export function withExisting(groups: readonly DupGroup[], existing: ReadonlySet<number>): DupGroup[] {
  return groups
    .map((g) => ({ ...g, members: g.members.filter((m) => existing.has(m.id)) }))
    .filter((g) => g.members.length > 1)
}

/** Bytes the ticked images of these groups take up. */
export function reclaimable(groups: readonly DupGroup[], ticks: ReadonlyMap<number, ReadonlySet<number>>): number {
  let bytes = 0
  for (const g of groups) {
    const marked = new Set(marksOf(g, ticks.get(g.group_id)))
    for (const m of g.members) if (marked.has(m.id)) bytes += m.file_size ?? 0
  }
  return bytes
}
