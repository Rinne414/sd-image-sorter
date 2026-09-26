import type { ImageSummary } from '../../api/types'

// Similarity endpoints answer with ids and a cosine score; the gallery needs
// its own rows. These put the two together without losing the ranking.

/** CLIP cosine at or above which two images count as near-duplicates (V3.5's middle setting). */
export const NEAR_DUPLICATE = 0.9

export interface Hit {
  id: number
  similarity: number
}

export type RankedImage = ImageSummary & { similarity: number }

/**
 * Rows in the order of the hits, each with its score; hits below `floor` and
 * hits without a row (gone, other library) drop out.
 */
export function mergeRanked(hits: readonly Hit[], rows: readonly ImageSummary[], floor = 0): RankedImage[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: RankedImage[] = []
  const seen = new Set<number>()
  for (const hit of hits) {
    if (seen.has(hit.id) || hit.similarity < floor) continue
    const row = byId.get(hit.id)
    if (!row) continue
    seen.add(hit.id)
    out.push({ ...row, similarity: hit.similarity })
  }
  return out
}

/** Hits from any similarity endpoint's `results`, cleaned. */
export function readHits(results: unknown): Hit[] {
  if (!Array.isArray(results)) return []
  return results.flatMap((r: unknown) => {
    if (!r || typeof r !== 'object') return []
    const id = Number((r as { id?: unknown }).id)
    const similarity = Number((r as { similarity?: unknown }).similarity)
    return Number.isFinite(id) && id > 0 && Number.isFinite(similarity) ? [{ id, similarity }] : []
  })
}

/** 0.9734 → "97%"; never shows 100% for anything short of identical. */
export function percent(similarity: number): string {
  const p = Math.floor(Math.max(0, Math.min(1, similarity)) * 100)
  return `${similarity >= 0.9995 ? 100 : Math.min(p, 99)}%`
}
