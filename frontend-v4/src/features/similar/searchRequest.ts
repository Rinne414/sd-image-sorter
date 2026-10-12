import { NEAR_DUPLICATE } from './ranking'
import type { SimilarQuery } from './similarStore'

// What a similarity search sends for the threshold and the scope, like V3.5's
// search panel: the threshold (default 50 %) applies to "like this image" and
// "like this file"; a sentence is ranked top-k (its scores sit near 0.2-0.35);
// the scope is the whole library, Favorites or another collection. Pure.

/** V3.5's search threshold default. */
export const DEFAULT_THRESHOLD = 0.5

export interface SearchOptions {
  /** Lowest likeness shown, 0-1 (only where usesThreshold). */
  threshold: number
  /** Only the images of this collection (Favorites is one); null: the whole library. */
  collectionId: number | null
}

/** Whether the threshold applies to this search. */
export function usesThreshold(q: SimilarQuery): boolean {
  return q.kind === 'upload' || (q.kind === 'image' && !q.near)
}

const scoped = (o: SearchOptions) => (o.collectionId ? { collection_id: o.collectionId } : {})

/** The body of POST /api/similarity/search-text. */
export function textBody(text: string, limit: number, offset: number, o: SearchOptions) {
  return { query: text, limit, offset, threshold: 0, ...scoped(o) }
}

/** The query string of POST /api/similarity/search-upload. */
export function uploadSearch(limit: number, offset: number, o: SearchOptions): string {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset), threshold: String(o.threshold) })
  if (o.collectionId) params.set('collection_id', String(o.collectionId))
  return params.toString()
}

/** The query of GET /api/similarity/near/{id} (top-k, no threshold of its own). */
export function nearQuery(limit: number, o: SearchOptions): { limit: number; collection_id?: number } {
  return { limit, ...scoped(o) }
}

/** The lowest score kept from the answer: near-duplicates 90 %, "like this image" the threshold, else all. */
export function hitFloor(q: SimilarQuery, o: SearchOptions): number {
  if (q.kind !== 'image') return 0
  return q.near ? NEAR_DUPLICATE : o.threshold
}
