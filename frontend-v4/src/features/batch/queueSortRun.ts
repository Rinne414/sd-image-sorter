import type { Entry } from './entries'
import {
  aestheticGroup,
  assignByRules,
  profileGroups,
  ratingGroup,
  resolutionGroup,
  SORT_GROUPS,
  SORT_TITLE,
  type Group,
  type GroupName,
  type Profile,
  type RatingTag,
  type SortKey,
} from './queueSort'
import { matchCondition } from './stepView'
import { fetchScores } from './useBatchScores'

// Working out which group each image of a queue belongs to. Rating and the
// profile rules ask the server (the library's own search, the same one the
// batch's condition box uses); aesthetic score comes from the library rows;
// resolution is already on the entries.

export type SortSpec = { kind: 'builtin'; key: SortKey } | { kind: 'profile'; profile: Profile }

/** What the Order step needs to mark a sort: its name, its groups, and where each image went. */
export interface Grouping {
  title: GroupName
  groups: readonly Group[]
  of: Readonly<Record<string, string>>
  /** The queue's order just before the sort (Undo going back to it takes the marks away). */
  before: readonly string[]
}

const RATINGS: readonly RatingTag[] = ['explicit', 'questionable', 'sensitive', 'general']

export const titleOf = (spec: SortSpec): GroupName => (spec.kind === 'profile' ? { text: spec.profile.name } : { key: SORT_TITLE[spec.key] })

export const groupsOf = (spec: SortSpec): readonly Group[] => (spec.kind === 'profile' ? profileGroups(spec.profile) : SORT_GROUPS[spec.key])

const libraryIds = (entries: readonly Entry[]): number[] => entries.flatMap((entry) => (entry.imageId === null ? [] : [entry.imageId]))

/** Which group each entry (by key) goes to under this sort. */
export async function groupEntries(spec: SortSpec, entries: readonly Entry[]): Promise<Map<string, string>> {
  if (spec.kind === 'profile') {
    const matching = await Promise.all(spec.profile.rules.map((rule) => matchCondition(rule.condition, entries)))
    return assignByRules(
      entries.map((entry) => entry.key),
      spec.profile.rules,
      matching,
    )
  }
  if (spec.key === 'resolution') return new Map(entries.map((entry) => [entry.key, resolutionGroup(entry.width, entry.height)]))
  if (spec.key === 'aesthetic') {
    const scores = await fetchScores(libraryIds(entries))
    return new Map(entries.map((entry) => [entry.key, aestheticGroup(entry.imageId === null ? null : scores.get(entry.imageId))]))
  }
  const found = await Promise.all(RATINGS.map(async (rating) => [rating, await matchCondition(`rating:${rating}`, entries)] as const))
  return new Map(
    entries.map((entry) => {
      const has = new Set(found.flatMap(([rating, keys]) => (keys.has(entry.key) ? [rating] : [])))
      return [entry.key, ratingGroup(has)]
    }),
  )
}
