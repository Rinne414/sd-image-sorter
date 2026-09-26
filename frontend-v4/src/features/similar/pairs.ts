// "相似的一对": V3.5's pair finder (Similar › duplicates) over
// GET /api/similarity/duplicates: every two images of the library at least
// this alike, most alike first, 50-99 % (the endpoint's range), 500 a page.
// Low values live here, not in the grouped cleanup: a pair is looked at one
// by one, while groups at low likeness chain into huge ones. Pure.

/** V3.5's pair finder default. */
export const PAIR_DEFAULT = 0.95
export const PAIR_MIN = 0.5
export const PAIR_MAX = 0.99
/** V3.5's page of pairs. */
export const PAIR_PAGE = 500
/** Below this, most pairs are only alike, not duplicates: said plainly, never blocked. */
const WARN_BELOW = 0.9

export interface PairImage {
  id: number
  filename: string
}

export interface Pair {
  a: PairImage
  b: PairImage
  similarity: number
}

export type PairProblem = { kind: 'too-few'; embedded: number; minimum: number } | { kind: 'too-many'; embedded: number; max: number }

export interface PairsReply {
  pairs: Pair[]
  total: number
  hasMore: boolean
  problem: PairProblem | null
}

/** The query of GET /api/similarity/duplicates. */
export function pairQuery(threshold: number, offset: number): { threshold: number; limit: number; offset: number } {
  const clamped = Math.min(PAIR_MAX, Math.max(PAIR_MIN, threshold))
  return { threshold: Math.round(clamped * 100) / 100, limit: PAIR_PAGE, offset }
}

export const warnsLow = (threshold: number) => threshold < WARN_BELOW

function image(raw: unknown): PairImage | null {
  if (!raw || typeof raw !== 'object') return null
  const { id, filename } = raw as { id?: unknown; filename?: unknown }
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? { id: n, filename: typeof filename === 'string' ? filename : '' } : null
}

const count = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

function problemOf(body: Record<string, unknown>): PairProblem | null {
  if (body.reason === 'insufficient_embeddings') return { kind: 'too-few', embedded: count(body.embedded_count), minimum: count(body.minimum_required) || 2 }
  if (body.reason === 'too_many_embeddings') return { kind: 'too-many', embedded: count(body.embedded_count), max: count(body.max_embeddings) }
  return null
}

/** The endpoint's answer: pairs in its order (rows it cannot use dropped), and why there are none. */
export function readPairs(raw: unknown): PairsReply {
  if (!raw || typeof raw !== 'object') return { pairs: [], total: 0, hasMore: false, problem: null }
  const body = raw as Record<string, unknown>
  const rows = Array.isArray(body.duplicates) ? body.duplicates : []
  const pairs = rows.flatMap((row: unknown) => {
    const r = (row ?? {}) as { image_a?: unknown; image_b?: unknown; similarity?: unknown }
    const a = image(r.image_a)
    const b = image(r.image_b)
    const similarity = Number(r.similarity)
    return a && b && Number.isFinite(similarity) ? [{ a, b, similarity }] : []
  })
  return { pairs, total: count(body.total) || pairs.length, hasMore: body.has_more === true, problem: problemOf(body) }
}

/** Pairs whose two images both still exist. */
export function withoutGone(pairs: readonly Pair[], existing: ReadonlySet<number>): Pair[] {
  return pairs.filter((p) => existing.has(p.a.id) && existing.has(p.b.id))
}
