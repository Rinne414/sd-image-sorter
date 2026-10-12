// The V3.5 sort list, as base orders plus one "reverse" switch.
// Each base names its natural direction and the backend key for the other way.

export type SortBase =
  | 'newest'
  | 'name'
  | 'generator'
  | 'prompt_length'
  | 'tag_count'
  | 'content_rating'
  | 'user_rating'
  | 'character_count'
  | 'file_size'
  | 'aesthetic'
  | 'brightness'
  | 'saturation'
  | 'brightness_skew'
  | 'random'

interface SortSpec {
  base: SortBase
  natural: string
  reversed: string | null
}

export const SORTS: SortSpec[] = [
  { base: 'newest', natural: 'newest', reversed: 'oldest' },
  { base: 'user_rating', natural: 'user_rating', reversed: 'user_rating_asc' },
  { base: 'aesthetic', natural: 'aesthetic', reversed: 'aesthetic_asc' },
  { base: 'name', natural: 'name_asc', reversed: 'name_desc' },
  { base: 'generator', natural: 'generator', reversed: 'generator_desc' },
  { base: 'content_rating', natural: 'rating', reversed: 'rating_desc' },
  { base: 'prompt_length', natural: 'prompt_length', reversed: 'prompt_length_asc' },
  { base: 'tag_count', natural: 'tag_count', reversed: 'tag_count_asc' },
  { base: 'character_count', natural: 'character_count', reversed: 'character_count_asc' },
  { base: 'file_size', natural: 'file_size', reversed: 'file_size_asc' },
  { base: 'brightness', natural: 'brightness', reversed: 'brightness_asc' },
  { base: 'saturation', natural: 'saturation', reversed: 'saturation_asc' },
  { base: 'brightness_skew', natural: 'brightness_skew', reversed: 'brightness_skew_asc' },
  { base: 'random', natural: 'random', reversed: null },
]

const BY_BASE = new Map(SORTS.map((s) => [s.base, s]))

export function isSortBase(v: unknown): v is SortBase {
  return typeof v === 'string' && BY_BASE.has(v as SortBase)
}

/** The backend sort_by value for a base order and the reverse switch. */
export function apiSort(base: SortBase, reverse: boolean): string {
  const spec = BY_BASE.get(base) ?? SORTS[0]!
  return reverse && spec.reversed ? spec.reversed : spec.natural
}

export function canReverse(base: SortBase): boolean {
  return BY_BASE.get(base)?.reversed != null
}

/** Colour sorts need colour analysis first (the backend sorts unanalysed images last). */
export function needsColorData(base: SortBase): boolean {
  return base === 'brightness' || base === 'saturation' || base === 'brightness_skew'
}
