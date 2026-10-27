import type { MessageKey } from '../../i18n'

// Sorting a batch's queue into groups, the way the classic page's Queue
// Solitaire does: by rating, by aesthetic score, by resolution, or by a saved
// profile (rules in order: an image goes to the first rule it matches).
// Classic shows the groups as sections; here the queue is one list, so the
// images are put in group order (the order inside a group stays as it was) and
// the Order step marks where each group starts. Pure rules only; the runner
// that asks the server is queueSortRun.ts. Every function returns new data.

export type SortKey = 'rating' | 'aesthetic' | 'resolution'

/** The colours a group can carry: tokens the interface already has (queueSort.module.css). */
export type Tone = 'gray' | 'green' | 'gold' | 'red' | 'light'

export const TONES: readonly Tone[] = ['gray', 'green', 'gold', 'red', 'light']

/** A group's name: a built-in one is translated, a profile rule's is the user's own text. */
export type GroupName = { key: MessageKey } | { text: string }

export interface Group {
  id: string
  tone: Tone
  name: GroupName
}

export const UNSORTED = 'unsorted'

const group = (id: string, tone: Tone, key: MessageKey): Group => ({ id, tone, name: { key } })

/** The groups of each built-in sort, best first (classic's order). The last one takes what has no value. */
export const SORT_GROUPS: Readonly<Record<SortKey, readonly Group[]>> = {
  rating: [
    group('general', 'green', 'partialsb.group.general'),
    group('sensitive', 'gold', 'partialsb.group.sensitive'),
    group('questionable', 'light', 'partialsb.group.questionable'),
    group('explicit', 'red', 'partialsb.group.explicit'),
    group('unrated', 'gray', 'partialsb.group.unrated'),
  ],
  aesthetic: [
    group('great', 'green', 'partialsb.group.great'),
    group('good', 'light', 'partialsb.group.good'),
    group('low', 'red', 'partialsb.group.low'),
    group('unscored', 'gray', 'partialsb.group.unscored'),
  ],
  resolution: [
    group('hd', 'green', 'partialsb.group.hd'),
    group('sd', 'light', 'partialsb.group.sd'),
    group('unknown', 'gray', 'partialsb.group.unknown'),
  ],
}

export const SORT_TITLE: Readonly<Record<SortKey, MessageKey>> = {
  rating: 'partialsb.sort.rating',
  aesthetic: 'partialsb.sort.aesthetic',
  resolution: 'partialsb.sort.resolution',
}

/** Scores from here up are Great, from here up Good (classic's 7 and 5). */
export const GREAT_FROM = 7
export const GOOD_FROM = 5

/** The longer side from here up is HD (classic's 1920). */
export const HD_FROM = 1920

export type RatingTag = 'general' | 'sensitive' | 'questionable' | 'explicit'

/**
 * The rating group of an image, from which of the four rating searches found it.
 * An image that was never tagged is found by every rating search (the library's
 * rating filter lets untagged images through), so one found by all four has no
 * rating. Otherwise the most explicit one wins (classic: explicit over
 * questionable over sensitive over general).
 */
export function ratingGroup(has: ReadonlySet<RatingTag>): string {
  if (has.size === 4) return 'unrated'
  if (has.has('explicit')) return 'explicit'
  if (has.has('questionable')) return 'questionable'
  if (has.has('sensitive')) return 'sensitive'
  if (has.has('general')) return 'general'
  return 'unrated'
}

export function aestheticGroup(score: number | null | undefined): string {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'unscored'
  if (score >= GREAT_FROM) return 'great'
  return score >= GOOD_FROM ? 'good' : 'low'
}

export function resolutionGroup(width: number | null, height: number | null): string {
  const longest = Math.max(width ?? 0, height ?? 0)
  if (longest === 0) return 'unknown'
  return longest >= HD_FROM ? 'hd' : 'sd'
}

/**
 * The keys in group order. An image goes after the ones of the groups before
 * its own, and keeps its place among the ones of its group; an image with no
 * group (or a group that is not listed) goes to the end, after the last group.
 */
export function arrange(order: readonly string[], groups: readonly Group[], groupOf: ReadonlyMap<string, string>): string[] {
  const rank = new Map(groups.map((g, i) => [g.id, i]))
  const last = groups.length
  const rankOf = (key: string) => rank.get(groupOf.get(key) ?? '') ?? last
  return order
    .map((key, at) => ({ key, at, rank: rankOf(key) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((row) => row.key)
}

/** How many images each group holds, in the groups' order (empty groups included). */
export function groupCounts(groups: readonly Group[], keys: readonly string[], groupOf: ReadonlyMap<string, string>): number[] {
  const counts = groups.map(() => 0)
  const at = new Map(groups.map((g, i) => [g.id, i]))
  for (const key of keys) {
    const i = at.get(groupOf.get(key) ?? '')
    if (i !== undefined) counts[i] = (counts[i] ?? 0) + 1
  }
  return counts
}

/** One run of the queue that belongs to one group (the Order step draws a heading at each start). */
export interface Run {
  group: Group | null
  start: number
  end: number
}

/** The queue cut into runs of one group each, in queue order; `groups` null means no sort is shown. */
export function runsOf(keys: readonly string[], groups: readonly Group[] | null, groupOf: ReadonlyMap<string, string>): Run[] {
  if (!groups) return keys.length === 0 ? [] : [{ group: null, start: 0, end: keys.length }]
  const byId = new Map(groups.map((g) => [g.id, g]))
  const runs: Run[] = []
  keys.forEach((key, i) => {
    const id = groupOf.get(key) ?? ''
    const previous = runs[runs.length - 1]
    const same = previous !== undefined && (previous.group?.id ?? '') === id
    if (previous && same) previous.end = i + 1
    else runs.push({ group: byId.get(id) ?? null, start: i, end: i + 1 })
  })
  return runs
}

// ---- saved profiles -------------------------------------------------------

/** One rule of a profile: images matching the condition (the library's search language) go to this group. */
export interface Rule {
  id: string
  name: string
  tone: Tone
  condition: string
}

export interface Profile {
  id: string
  name: string
  rules: Rule[]
}

const isTone = (value: unknown): value is Tone => typeof value === 'string' && (TONES as readonly string[]).includes(value)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Profiles as stored; whatever is not a usable profile is left out. */
export function parseProfiles(raw: string | null): Profile[] {
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  return data.flatMap((entry: unknown): Profile[] => {
    if (!entry || typeof entry !== 'object') return []
    const p = entry as { id?: unknown; name?: unknown; rules?: unknown }
    const name = text(p.name).trim()
    if (!name) return []
    const rules = Array.isArray(p.rules)
      ? p.rules.flatMap((r: unknown, i: number): Rule[] => {
          if (!r || typeof r !== 'object') return []
          const rule = r as { id?: unknown; name?: unknown; tone?: unknown; condition?: unknown }
          return [
            {
              id: text(rule.id) || `rule-${i}`,
              name: text(rule.name).trim() || `${i + 1}`,
              tone: isTone(rule.tone) ? rule.tone : (TONES[i % TONES.length] as Tone),
              condition: text(rule.condition),
            },
          ]
        })
      : []
    return [{ id: text(p.id) || `profile-${name}`, name, rules }]
  })
}

/** A name not used yet: `base`, else `base 2`, `base 3`... */
export function freeName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()))
  if (!used.has(base.trim().toLowerCase())) return base.trim()
  for (let n = 2; ; n++) {
    const next = `${base.trim()} ${n}`
    if (!used.has(next.toLowerCase())) return next
  }
}

export const newRule = (index: number, name: string): Rule => ({
  id: `rule-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 6)}`,
  name,
  tone: TONES[index % TONES.length] as Tone,
  condition: '',
})

export const newProfile = (name: string, first: Rule): Profile => ({
  id: `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  name,
  rules: [first],
})

export const replaceProfile = (list: readonly Profile[], next: Profile): Profile[] => list.map((p) => (p.id === next.id ? next : p))

export const removeProfile = (list: readonly Profile[], id: string): Profile[] => list.filter((p) => p.id !== id)

/** The groups a profile makes, in rule order, then what no rule took. */
export function profileGroups(profile: Profile): Group[] {
  return [
    ...profile.rules.map((r): Group => ({ id: r.id, tone: r.tone, name: { text: r.name } })),
    { id: UNSORTED, tone: 'gray', name: { key: 'partialsb.group.unsorted' } },
  ]
}

/**
 * Which rule takes each key: the first one whose matching set holds it; keys no
 * rule matches go to `unsorted`. `matching` is one set of keys per rule, in the rule order.
 */
export function assignByRules(keys: readonly string[], rules: readonly Rule[], matching: readonly ReadonlySet<string>[]): Map<string, string> {
  const of = new Map<string, string>()
  for (const key of keys) {
    const at = matching.findIndex((set) => set.has(key))
    of.set(key, at >= 0 ? (rules[at] as Rule).id : UNSORTED)
  }
  return of
}
