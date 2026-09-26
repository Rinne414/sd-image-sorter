import type { Quality } from './generateBody'
import type { Setup, Slots } from './slots'

// Random mode's setup: the slots with their weights and locks, the fixed
// words, the tag sets in use and the generate options. A preset is a saved
// copy of it.

export interface RandomSetup extends Setup {
  prepend: string
  append: string
  /** Ids of the tag sets in use, as text. */
  tagSets: string[]
  quality: Quality
  negative: boolean
  count: number
  /** As typed: '' means a new seed each run. */
  seed: string
}

export const EMPTY_SETUP: RandomSetup = {
  slots: {},
  weights: {},
  locked: {},
  prepend: '',
  append: '',
  tagSets: [],
  quality: 'high',
  negative: true,
  count: 1,
  seed: '',
}

const QUALITIES: readonly Quality[] = ['high', 'medium', 'none']

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

function stringLists(v: unknown): Slots {
  const out: Slots = {}
  for (const [k, list] of Object.entries(obj(v))) if (Array.isArray(list)) out[k] = list.map(String).filter(Boolean)
  return out
}

function numbers(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(obj(v))) if (typeof n === 'number' && n >= 0 && n <= 100) out[k] = n
  return out
}

function flags(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [k, b] of Object.entries(obj(v))) if (b === true) out[k] = true
  return out
}

/**
 * A setup from stored JSON or a preset's config. Presets keep V3.5's keys
 * (slots, weights, locked, prependTags, appendTags), so a preset saved in
 * either app loads in the other; the V4 options ride along beside them.
 */
export function readSetup(raw: unknown): RandomSetup {
  const c = obj(raw)
  const count = Number(c.count)
  return {
    slots: stringLists(c.slots),
    weights: numbers(c.weights),
    locked: flags(c.locked),
    prepend: typeof c.prependTags === 'string' ? c.prependTags : '',
    append: typeof c.appendTags === 'string' ? c.appendTags : '',
    tagSets: Array.isArray(c.tagSets) ? c.tagSets.map(String) : [],
    quality: QUALITIES.find((q) => q === c.quality) ?? EMPTY_SETUP.quality,
    negative: typeof c.includeNegative === 'boolean' ? c.includeNegative : EMPTY_SETUP.negative,
    count: Number.isInteger(count) && count >= 1 ? count : 1,
    seed: typeof c.seed === 'string' ? c.seed : '',
  }
}

/** The setup as a preset's config (and as it is stored). */
export function setupConfig(s: RandomSetup): Record<string, unknown> {
  return {
    slots: s.slots,
    weights: s.weights,
    locked: s.locked,
    prependTags: s.prepend,
    appendTags: s.append,
    tagSets: s.tagSets,
    quality: s.quality,
    includeNegative: s.negative,
    count: s.count,
    seed: s.seed,
  }
}
