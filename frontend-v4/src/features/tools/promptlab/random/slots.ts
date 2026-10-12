// Random mode's slots: one list of tags per category, a weight (the chance a
// category is drawn at all) and a lock (a locked slot is never redrawn). The
// draw is seeded, so the same seed on the same tags gives the same prompt.

export type Slots = Record<string, string[]>

export interface Setup {
  slots: Slots
  /** 0-100; a category without one uses DEFAULT_WEIGHT. */
  weights: Record<string, number>
  locked: Record<string, boolean>
}

export interface Rule {
  id: number | string | null
  name: string
  description?: string
  conditions: { tag: string; type: string }[]
  targets: { tag: string; category: string | null }[]
}

export const DEFAULT_WEIGHT = 50

/** Never filled by a draw (V3.5 alike): meta, rating and unclassified words. */
const NOT_DRAWN = new Set(['unknown', 'rating', 'meta'])

/** Where the one fallback tag comes from when a draw came out empty. */
const FALLBACK = ['character', 'outfit', 'style', 'pose', 'background', 'expression', 'body', 'angle', 'quality']

/** A small seeded generator (mulberry32): numbers in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `n` different items, picked by `next`. */
function pick<T>(items: readonly T[], n: number, next: () => number): T[] {
  const copy = [...items]
  const out: T[] = []
  for (let i = 0; i < n && copy.length; i++) {
    const at = Math.floor(next() * copy.length)
    out.push(copy[at] as T)
    copy[at] = copy[copy.length - 1] as T
    copy.pop()
  }
  return out
}

/** Tags compared the way the backend compares them: case and spaces against _ ignored. */
export const tagKey = (tag: string) => tag.trim().toLowerCase().replace(/[\s_]+/g, '_')

function metRules(slots: Slots, rules: readonly Rule[]): Rule[] {
  const active = new Set(Object.values(slots).flat().map(tagKey))
  return rules.filter((rule) => {
    const present = rule.conditions.filter((c) => (c.type || 'present') === 'present')
    return present.length > 0 && present.every((c) => active.has(tagKey(c.tag)))
  })
}

const targetsOf = (rule: Rule) => new Set(rule.targets.map((t) => t.tag).filter(Boolean).map(tagKey))

/** Drawn tags a rule forbids go; the user's locked slots are never touched. */
function dropExcluded(slots: Slots, locked: Record<string, boolean>, rules: readonly Rule[]): Slots {
  const banned = new Set(metRules(slots, rules).flatMap((rule) => [...targetsOf(rule)]))
  if (!banned.size) return slots
  const out: Slots = {}
  for (const [cat, tags] of Object.entries(slots)) out[cat] = locked[cat] ? tags : tags.filter((tag) => !banned.has(tagKey(tag)))
  return out
}

/**
 * Redraw every unlocked category from the pool: with its weight as the chance,
 * one to three different tags, else none. Locked slots stay as they are.
 */
export function drawSlots(pool: Record<string, readonly string[]>, setup: Setup, seed: number, rules: readonly Rule[] = []): Slots {
  const next = rng(seed)
  const slots: Slots = { ...setup.slots }
  for (const [cat, tags] of Object.entries(pool)) {
    if (NOT_DRAWN.has(cat) || setup.locked[cat] || tags.length === 0) continue
    const weight = (setup.weights[cat] ?? DEFAULT_WEIGHT) / 100
    slots[cat] = next() < weight ? pick(tags, Math.floor(next() * 3) + 1, next) : []
  }
  if (Object.values(slots).every((tags) => tags.length === 0)) {
    const cat = FALLBACK.find((c) => (pool[c]?.length ?? 0) > 0) ?? Object.keys(pool).find((c) => (pool[c]?.length ?? 0) > 0)
    if (cat) slots[cat] = pick(pool[cat] ?? [], 1, next)
  }
  return dropExcluded(slots, setup.locked, rules)
}

export interface Conflict {
  /** The rule's name. */
  rule: string
  /** The tags that set the rule off. */
  when: string[]
  /** The tag in this slot the rule rules out. */
  tag: string
}

/** For each slot, the tags in it that a rule rules out (and why). */
export function conflictsBySlot(slots: Slots, rules: readonly Rule[]): Record<string, Conflict[]> {
  const out: Record<string, Conflict[]> = {}
  for (const rule of metRules(slots, rules)) {
    const targets = targetsOf(rule)
    const when = rule.conditions.filter((c) => (c.type || 'present') === 'present').map((c) => c.tag)
    for (const [cat, tags] of Object.entries(slots)) {
      for (const tag of tags) if (targets.has(tagKey(tag))) (out[cat] ??= []).push({ rule: rule.name, when, tag })
    }
  }
  return out
}

const splitWords = (text: string) => text.split(',').map((w) => w.trim()).filter(Boolean)

/** The fixed words first and last around the prompt, each word once. */
export function withAffixes(prompt: string, prepend: string, append: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const word of [...splitWords(prepend), ...splitWords(prompt), ...splitWords(append)]) {
    const key = tagKey(word)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out.join(', ')
}

export function toggleTag(slots: Slots, cat: string, tag: string): Slots {
  const tags = slots[cat] ?? []
  return { ...slots, [cat]: tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag] }
}

export function removeTag(slots: Slots, cat: string, tag: string): Slots {
  return { ...slots, [cat]: (slots[cat] ?? []).filter((t) => t !== tag) }
}

/** Put words into the slots of their categories; a word already in any slot is skipped. */
export function placeTags(slots: Slots, words: readonly { tag: string; category: string }[]): { slots: Slots; added: number } {
  const out: Slots = { ...slots }
  const seen = new Set(Object.values(slots).flat().map(tagKey))
  let added = 0
  for (const { tag, category } of words) {
    if (seen.has(tagKey(tag))) continue
    seen.add(tagKey(tag))
    out[category] = [...(out[category] ?? []), tag]
    added += 1
  }
  return { slots: out, added }
}

/** Every tag in the slots, once. */
export function slotTags(slots: Slots): string[] {
  return [...new Set(Object.values(slots).flat())]
}

/** A typed seed: a whole number from 0 up, else null (a new seed each run). */
export function parseSeed(text: string): number | null {
  const clean = text.trim()
  if (!/^\d+$/.test(clean)) return null
  const n = Number(clean)
  return Number.isSafeInteger(n) ? n : null
}

export const newSeed = () => Math.floor(Math.random() * 2 ** 31)

/** Several prompts from one seed use seed, seed + 1, … (the backend's own batch rule). */
export function seedsFor(base: number, count: number): number[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => base + i)
}
