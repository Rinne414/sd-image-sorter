import type { ImageQueryParams } from '../../lib/searchQuery'

// "Random image" draws from the WHOLE filtered result, not only the pages the
// gallery has loaded (V3.5's 🎲 only saw loaded images): pick an offset in
// [0, total) and ask the backend for the one image there, same filter, same
// sort. The same request steps to a neighbour when that image is outside the
// loaded pages.

export function randomOffset(total: number, rand: () => number = Math.random): number {
  if (total <= 0) return -1
  return Math.min(total - 1, Math.max(0, Math.floor(rand() * total)))
}

/** Query for the single image at `offset` in the current result. */
export function imageAtQuery(params: ImageQueryParams, offset: number): Record<string, unknown> {
  return { ...params, limit: 1, offset }
}
