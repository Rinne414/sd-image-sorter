import type { BatchItem } from '../../api/types'
import { parseReviewed } from '../censor/ops'

// What the export will use for each image, before anything is written:
// - censored: it has a censored copy (approving an image in review always
//   saves one, even when there was nothing to censor), which the export uses;
// - unreviewed: it has a copy made from AI detection nobody has reviewed yet;
// - missing: no copy: the export refuses unless the user chooses to leave it
//   out or to export its original.

export type Readiness = 'censored' | 'unreviewed' | 'missing'

export interface Preflight {
  total: number
  /** Images with a censored copy. */
  censored: number
  /** Images approved in review. */
  reviewed: number
  unreviewed: BatchItem[]
  missing: BatchItem[]
}

export function readiness(item: BatchItem): Readiness {
  if (!item.has_censored) return 'missing'
  return parseReviewed(item.item_state) === false ? 'unreviewed' : 'censored'
}

export function preflight(items: readonly BatchItem[]): Preflight {
  return {
    total: items.length,
    censored: items.filter((item) => item.has_censored).length,
    reviewed: items.filter((item) => parseReviewed(item.item_state) === true).length,
    unreviewed: items.filter((item) => readiness(item) === 'unreviewed'),
    missing: items.filter((item) => readiness(item) === 'missing'),
  }
}

/**
 * Images the server reported without a censored copy (a 409) that the local
 * list did not know about (e.g. a copy deleted elsewhere) join the missing
 * ones, in batch order.
 */
export function withServerMissing(check: Preflight, items: readonly BatchItem[], serverMissing: readonly number[]): Preflight {
  const known = new Set(check.missing.map((item) => item.image_id))
  const extra = new Set(serverMissing.filter((id) => !known.has(id) && items.some((item) => item.image_id === id)))
  if (extra.size === 0) return check
  return {
    ...check,
    unreviewed: check.unreviewed.filter((item) => !extra.has(item.image_id)),
    missing: items.filter((item) => known.has(item.image_id) || extra.has(item.image_id)),
  }
}

/** Where "go censor them" opens the editor: the first missing image, else the first unreviewed one. */
export function firstToFix(check: Preflight): { imageId: number; review: boolean } | null {
  const missing = check.missing[0]
  if (missing) return { imageId: missing.image_id, review: parseReviewed(missing.item_state) === false }
  const unreviewed = check.unreviewed[0]
  return unreviewed ? { imageId: unreviewed.image_id, review: true } : null
}
