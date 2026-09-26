// Where the library grid was scrolled to, per library and per search, so a
// reload or a visit to another tab comes back to the same images (V3.5's
// "back where you left off", 14 days). The spot is the first image showing
// at the top: an index survives a different window width, a pixel offset
// does not.

export interface ScrollSpot {
  /** The search it belongs to (the grid's parameters as JSON). */
  key: string
  /** Position of the top image in the result. */
  index: number
  /** That image, found again even when newer images pushed it down. */
  id: number
  /** When it was saved (ms). */
  at: number
}

export type ScrollStore = Record<string, ScrollSpot>

export const RESUME_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export function rememberSpot(store: ScrollStore, libraryId: string, spot: ScrollSpot): ScrollStore {
  return { ...store, [libraryId]: { ...spot } }
}

/** The spot to come back to, or null: another search, the top, or too old. */
export function spotToResume(store: ScrollStore, libraryId: string, key: string, now: number): ScrollSpot | null {
  const spot = store[libraryId]
  if (!spot || spot.key !== key || spot.index <= 0) return null
  if (now - spot.at > RESUME_MAX_AGE_MS) return null
  return spot
}

/**
 * Where to scroll in the loaded images: the remembered image if it is loaded,
 * else the same position once that many are loaded; null means load more.
 */
export function resumeIndex(spot: ScrollSpot, ids: readonly number[]): number | null {
  const at = ids.indexOf(spot.id)
  if (at >= 0) return at
  return spot.index < ids.length ? spot.index : null
}

export interface ItemBox {
  index: number
  start: number
  end: number
}

/** The first image (in list order) still showing at the top edge. */
export function firstVisibleIndex(items: readonly ItemBox[], scrollTop: number): number {
  let best = -1
  for (const item of items) {
    if (item.end > scrollTop && (best < 0 || item.index < best)) best = item.index
  }
  if (best >= 0) return best
  return items.reduce((last, item) => Math.max(last, item.index), 0)
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function parseScrollStore(raw: string | null): ScrollStore {
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  const store: ScrollStore = {}
  for (const [id, entry] of Object.entries(data as Record<string, unknown>)) {
    const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
    if (typeof e.key !== 'string' || !isNum(e.index) || !isNum(e.id) || !isNum(e.at)) continue
    store[id] = { key: e.key, index: e.index, id: e.id, at: e.at }
  }
  return store
}
