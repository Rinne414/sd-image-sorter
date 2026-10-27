import type { MessageKey, Params } from '../../i18n'
import type { LocateAnswer, NearAnswer, Neighbour, SelfPlace, Space, XYZ } from './types'

// The two lookups on the map, as pure decisions: "the pictures most like
// this one" (a dropped file through POST /query, a library picture through
// GET /near) and "find a picture" (POST /locate). What the card says, which
// rings the map draws and which neighbours are flagged.

export const NEAR_K = 20
/** The server's own upload ceiling. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** Past this a slow answer is most likely the first load of the model. */
export const SLOW_MODEL_MS = 1500
export const COLD_SECONDS = 15

export type RingKind = 'query' | 'near' | 'far'

export interface Ring extends XYZ {
  kind: RingKind
  id?: number
}

export type Tone = 'busy' | 'info' | 'warn' | 'error'

/** What a status line says, and the one button it may offer. */
export interface Note {
  key: MessageKey
  params?: Params
  tone: Tone
  action?: 'showAll' | 'build' | 'buildClip'
}

/** A failed lookup answer as one sentence. */
export function failureNote(status: number, detail: string): Note {
  if (status === 404) return { key: 'stylemap.near.errGone', tone: 'error' }
  if (status === 413) return { key: 'stylemap.near.errTooLarge', tone: 'error' }
  if (status === 409) return { key: 'stylemap.near.errBusy', tone: 'error' }
  if (status === 400 && /image/i.test(detail)) return { key: 'stylemap.near.errNotImage', tone: 'error' }
  return { key: 'stylemap.near.err', params: { error: detail || `HTTP ${status}` }, tone: 'error' }
}

/** A file the server would refuse anyway, said before it is sent; null when it can go. */
export function fileProblem(file: { type: string; size: number }): Note | null {
  if (file.type && !file.type.startsWith('image/')) return { key: 'stylemap.near.errNotImage', tone: 'error' }
  if (file.size > MAX_UPLOAD_BYTES) return { key: 'stylemap.near.errTooLarge', tone: 'error' }
  return null
}

/** The picture has no vector in this space: say so, with the way to get one. */
export const noVectorNote = (space: Space): Note =>
  space === 'clip' ? { key: 'stylemap.near.noClip', tone: 'warn', action: 'buildClip' } : { key: 'stylemap.near.noVector', tone: 'warn', action: 'build' }

/** The library filter leaves nothing on the map. */
export const outsideAllNote: Note = { key: 'stylemap.near.outsideAll', tone: 'warn', action: 'showAll' }

/** Where a library picture is; null when it sits on its own dot. */
export function placeNote(self: SelfPlace | null | undefined): Note | null {
  if (!self) return null
  if (!self.in_filter) return { key: 'stylemap.near.outsideOne', tone: 'warn', action: 'showAll' }
  if (!self.located) return { key: 'stylemap.near.unplacedOne', tone: 'warn' }
  if (self.merged) return { key: 'stylemap.near.mergedOne', tone: 'info' }
  return null
}

/** The slow-answer line for the space's model (the first load takes a while). */
export const slowNote = (space: Space): Note => ({
  key: space === 'csd' ? 'stylemap.near.loadingCsd' : 'stylemap.near.loadingModel',
  params: { seconds: COLD_SECONDS },
  tone: 'busy',
})

const isXyz = (n: Partial<XYZ>): n is XYZ => typeof n.x === 'number' && typeof n.y === 'number' && typeof n.z === 'number'

/** The rings of an answer: the query point, then one ring per dot (a merged picture shares its dot's ring). */
export function ringsOf(answer: NearAnswer | null): Ring[] {
  const rings: Ring[] = []
  if (!answer) return rings
  if (answer.query) rings.push({ kind: 'query', ...answer.query })
  const drawn = new Set<string>()
  for (const n of answer.neighbors ?? []) {
    if (!n.located || !isXyz(n)) continue
    const dot = `${n.x},${n.y},${n.z}`
    if (drawn.has(dot)) continue
    drawn.add(dot)
    rings.push({ kind: n.weak ? 'far' : 'near', id: n.id, x: n.x, y: n.y, z: n.z })
  }
  return rings
}

/** The small flags under a neighbour's name. */
export function neighbourFlags(n: Neighbour): MessageKey[] {
  const flags: MessageKey[] = []
  if (n.weak) flags.push('stylemap.near.far')
  if (n.merged) flags.push('stylemap.near.merged')
  if (!n.in_filter) flags.push('stylemap.near.outside')
  else if (!n.located) flags.push('stylemap.near.unplaced')
  return flags
}

/** Where a neighbour's dot is, or null when it has none on this map. */
export const neighbourDot = (n: Neighbour): [number, number, number] | null => (n.located && isXyz(n) ? [n.x, n.y, n.z] : null)

/** The note under the list. */
export function listNote(answer: NearAnswer, ofLibrary: boolean): Note {
  if (!(answer.neighbors ?? []).length) return { key: 'stylemap.near.nothing', tone: 'info' }
  const threshold = Number(answer.weak_threshold ?? 0).toFixed(2)
  if (ofLibrary) return { key: 'stylemap.near.libraryNote', params: { threshold }, tone: 'info' }
  if (!answer.query) return { key: 'stylemap.near.noPlace', tone: 'info' }
  return { key: 'stylemap.near.note', params: { threshold }, tone: 'info' }
}

/** Why a search found nothing on the map, in the order the user can act on it. */
export function locateEmptyNote(answer: LocateAnswer): Note {
  if ((answer.outside_filter ?? 0) > 0) return { key: 'stylemap.locate.outside', params: { count: answer.outside_filter ?? 0 }, tone: 'warn', action: 'showAll' }
  if ((answer.without_data ?? 0) > 0) return { key: 'stylemap.locate.noData', params: { count: answer.without_data ?? 0 }, tone: 'warn' }
  return { key: 'stylemap.locate.none', tone: 'info' }
}

/** The count line above the results. */
export function locateCount(answer: LocateAnswer): Note | null {
  const shown = answer.results?.length ?? 0
  if (!shown) return null
  const total = answer.total ?? shown
  return total > shown
    ? { key: 'stylemap.locate.countMore', params: { shown, total }, tone: 'info' }
    : { key: 'stylemap.locate.count', params: { total }, tone: 'info' }
}

/** One row moved by the arrow keys, wrapping around. */
export const stepActive = (active: number, step: 1 | -1, count: number): number => (count ? (active + step + count) % count : -1)
