import type { TagRow } from './captionOps'

// What the frequency table can say about a tag beyond its count: whether it is
// a trait of the character (hair, eyes, skin, body) that a character LoRA
// usually leaves to the trigger word. Pure: no requests.

export type TraitFamily = 'hair' | 'eyes' | 'skin' | 'body'

export interface TraitMark {
  family: TraitFamily
  /** Share of the captions in scope that have it. */
  ratio: number
}

// The trait families of backend services/trait_pruning_service.py
// (classify_trait_family), applied here to the batch's captions, which the
// endpoint (Library tags only) cannot see. captionOps.test.ts pins both
// against the same cases; change them together.
const HAIR_EXCLUSIONS = new Set([
  'adjusting_hair', 'hand_in_hair', 'hand_in_own_hair', 'playing_with_own_hair', 'wet_hair', 'hair_ornament', 'hair_flower',
  'hair_ribbon', 'hair_bow', 'hair_bobbles', 'hairband', 'hairclip', 'hair_tie', 'hair_scrunchie',
])
const EYE_EXCLUSIONS = new Set(['closed_eyes', 'half-closed_eyes', 'rolling_eyes', 'crossed_eyes'])
const SKIN_EXCLUSIONS = new Set(['shiny_skin'])
const HAIRSTYLE_TAGS = new Set([
  'twintails', 'ponytail', 'braid', 'ahoge', 'bangs', 'blunt_bangs', 'parted_bangs', 'swept_bangs', 'asymmetrical_bangs',
  'hair_between_eyes', 'hair_over_one_eye', 'hair_intakes', 'sidelocks', 'hime_cut', 'bob_cut', 'pixie_cut', 'hair_bun',
  'double_bun', 'single_hair_bun', 'low_twintails', 'short_twintails', 'side_ponytail', 'high_ponytail', 'low_ponytail',
  'braided_ponytail', 'twin_braids', 'side_braid', 'single_braid', 'french_braid', 'crown_braid', 'half_updo', 'hair_flaps',
])
const EYE_TAGS = new Set(['heterochromia', 'tsurime', 'tareme', 'long_eyelashes', 'thick_eyebrows'])
const SKIN_TAGS = new Set(['dark-skinned_female', 'dark-skinned_male', 'tan', 'tanlines'])
const BODY_TAGS = new Set([
  'flat_chest', 'small_breasts', 'medium_breasts', 'large_breasts', 'huge_breasts', 'gigantic_breasts', 'animal_ears',
  'animal_ear_fluff', 'tail', 'horns', 'halo', 'fang', 'fangs', 'skin_fang', 'mole', 'freckles', 'scar', 'muscular',
  'muscular_female', 'muscular_male', 'abs', 'thick_thighs', 'wide_hips', 'petite', 'elf', 'dark_elf', 'forehead',
])
const BODY_SUFFIXES = ['_ears', '_tail', '_horns', '_horn', '_wings']
const BODY_PREFIXES = ['mole_', 'scar_']

export function traitFamily(tag: string): TraitFamily | null {
  const t = tag.trim().toLowerCase().replace(/ /g, '_')
  if (!t || HAIR_EXCLUSIONS.has(t) || EYE_EXCLUSIONS.has(t) || SKIN_EXCLUSIONS.has(t)) return null
  if (t.endsWith('_hair') || HAIRSTYLE_TAGS.has(t)) return 'hair'
  if (t.endsWith('_eyes') || t.endsWith('_pupils') || EYE_TAGS.has(t)) return 'eyes'
  if (t.endsWith('_skin') || SKIN_TAGS.has(t)) return 'skin'
  if (BODY_TAGS.has(t) || BODY_SUFFIXES.some((s) => t.endsWith(s)) || BODY_PREFIXES.some((p) => t.startsWith(p)) || t === 'wings') return 'body'
  return null
}

/** The share of captions a trait must reach to be suggested (the endpoint's default). */
export const TRAIT_MIN_RATIO = 0.6

/** Traits most captions in scope share, by tag key: candidates to leave to the trigger word. */
export function traitMarks(rows: readonly TagRow[], scopeSize: number, minRatio = TRAIT_MIN_RATIO): Map<string, TraitMark> {
  const out = new Map<string, TraitMark>()
  if (scopeSize <= 0) return out
  for (const row of rows) {
    const family = traitFamily(row.tag)
    const ratio = row.count / scopeSize
    if (family && ratio >= minRatio) out.set(row.key, { family, ratio })
  }
  return out
}
