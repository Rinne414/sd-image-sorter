import type { ImageQueryParams } from '../../lib/searchQuery'
import type { ModelCard } from '../tagging/taggers'

// Pure decisions for aesthetic scoring (aesthetic.ts runs it).

export type ModelState = 'ready' | 'download' | 'restart'

/** The model card decides; unknown (no card) lets the work try and the backend say what is missing. */
export function aestheticModelState(cards: readonly ModelCard[] | undefined): ModelState {
  const card = cards?.find((c) => c.id === 'aesthetic')
  if (!card) return 'ready'
  if (card.status === 'needs_restart') return 'restart'
  return card.status === 'ready' || card.available === true ? 'ready' : 'download'
}

/** The filter's images without a score (aesthetic ranges left out: they exclude unscored images). */
export function unscoredParams(params: ImageQueryParams): ImageQueryParams {
  const rest: ImageQueryParams = { ...params, aesthetic_unscored: true }
  for (const key of ['min_aesthetic', 'max_aesthetic', 'sort_by']) delete rest[key]
  return rest
}
