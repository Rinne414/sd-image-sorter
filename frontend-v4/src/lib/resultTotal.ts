import type { ImageQueryParams } from './searchQuery'

// The library's result count. For whole-word prompt terms the backend counts
// with a broad SQL match ("blue eyes" also finds "light blue eyes") and checks
// the whole words only on the rows it returns, so its total can be too high
// (its own `exact: false`). Pure.

/** Whether the backend's total for these filters is only an estimate. */
export function totalIsEstimate(params: Partial<ImageQueryParams>): boolean {
  return !!params.prompts && params.prompt_match_mode !== 'contains'
}

/**
 * What to show: the backend's total when it is exact; the images themselves
 * once every page of an estimate is here (they are the exact answer); else
 * the estimate, marked "about".
 */
export function shownTotal(total: number | null, estimate: boolean, loaded: number, hasMore: boolean): { n: number; about: boolean } | null {
  if (total === null) return null
  if (!estimate) return { n: total, about: false }
  if (!hasMore) return { n: loaded, about: false }
  return { n: total, about: true }
}
