// Duplicate review: the last scan's groups, each with one image to keep.
// The scan suggests a keeper (best rating, aesthetic, resolution, file
// size); the user may pick another. Everything not kept is what "remove the
// others" acts on. Pure, so what gets removed is tested.

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

/** The keeper of a group: the user's choice when it is still a member, else the suggestion, else the first. */
export function keeperOf(group: DupGroup, chosen: number | undefined): number {
  if (chosen !== undefined && group.members.some((m) => m.id === chosen)) return chosen
  return (group.members.find((m) => m.suggested_keep) ?? group.members[0])?.id ?? -1
}

/** Everything in the group except its keeper. */
export function othersOf(group: DupGroup, chosen: number | undefined): number[] {
  const keep = keeperOf(group, chosen)
  return group.members.filter((m) => m.id !== keep).map((m) => m.id)
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

/** Bytes the others of these groups take up. */
export function reclaimable(groups: readonly DupGroup[], chosen: ReadonlyMap<number, number>): number {
  let bytes = 0
  for (const g of groups) {
    const keep = keeperOf(g, chosen.get(g.group_id))
    for (const m of g.members) if (m.id !== keep) bytes += m.file_size ?? 0
  }
  return bytes
}
