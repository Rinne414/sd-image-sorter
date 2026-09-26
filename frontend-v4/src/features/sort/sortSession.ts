import { readGeneration, type GenerationInfo } from '../../lib/meta'

// The Sort tab's session as the page sees it: which image is up, where each
// key sends it, how many went where. The backend owns the session (one saved
// session, restored after a reload or a restart); this module reads its
// answers and keeps key presses in order while they go out one at a time.
// Three ways to sort share it: keys to folders (slot), A/B showdown (bracket)
// and keep/reject (cull). Pure: sortStore.ts does the requests.

export const SLOT_KEYS = ['w', 'a', 's', 'd'] as const
export type SlotKey = (typeof SLOT_KEYS)[number]
export type FileOperation = 'move' | 'copy'
export type SortMode = 'slot' | 'bracket' | 'cull'
export const SORT_MODES: readonly SortMode[] = ['slot', 'bracket', 'cull']

export type SortAction =
  | { kind: 'slot'; slot: SlotKey }
  /** A/B: keep A (the one that has held so far) or take B (the new one). */
  | { kind: 'pick'; side: 'a' | 'b' }
  | { kind: 'keep' }
  | { kind: 'reject' }
  | { kind: 'skip' }
  | { kind: 'undo' }
  | { kind: 'redo' }

export type SlotMap<T> = Partial<Record<SlotKey, T>>

export interface SortImage {
  id: number
  filename: string
  path: string
  gen: GenerationInfo
  aesthetic: number | null
}

/** A/B: the pair on screen; `a` has held since `aIndex`, `b` is at `bIndex` in the order. */
export interface Duel {
  a: SortImage
  b: SortImage
  aIndex: number
  bIndex: number
}

export type Decision = 'keep' | 'reject'

export interface SessionView {
  mode: SortMode
  ids: number[]
  total: number
  /** Position of the image that is up (A/B: of B); `total` once every image is done. */
  index: number
  image: SortImage | null
  /** The library the images belong to (the one saved session is shared by all); null when unknown or `libraryMixed`. */
  libraryId: string | null
  /** The images come from more than one library. */
  libraryMixed: boolean
  folders: SlotMap<string>
  /** Slots V3.5 pointed at a collection: the key adds the image there and no file moves. */
  collections: SlotMap<number>
  operation: FileOperation
  counts: SlotMap<number>
  skipped: number
  canUndo: boolean
  canRedo: boolean
  duel: Duel | null
  /** A/B: the one left standing, once finished. */
  winner: SortImage | null
  /** Keep/reject: every decision, by image id. */
  decisions: Record<number, Decision>
}

/** What the last answered key did, for the line under the picture. */
export type LastAction =
  | { kind: 'slot'; slot: SlotKey; collect: boolean }
  | { kind: 'pick'; side: 'a' | 'b' }
  | { kind: 'keep' }
  | { kind: 'reject' }
  | { kind: 'skip' }
  | { kind: 'undo'; what: 'slot' | 'skip' | 'other' }
  | { kind: 'redo' }

export type SortError =
  | { kind: 'unset'; slot: SlotKey }
  | { kind: 'failed'; reason: string }
  | { kind: 'nothing' }
  | { kind: 'cooldown' }
  /** The images belong to another library and the user has not said to keep sorting them. */
  | { kind: 'otherLibrary' }

export interface SortState {
  /** null until the backend answered; 'none' when no session is saved. */
  session: SessionView | 'none' | null
  queue: SortAction[]
  sending: boolean
  error: SortError | null
  last: LastAction | null
}

export const INITIAL_STATE: SortState = { session: null, queue: [], sending: false, error: null, last: null }

const isSlot = (key: unknown): key is SlotKey => typeof key === 'string' && (SLOT_KEYS as readonly string[]).includes(key)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const idList = (v: unknown): number[] | null => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : null)

function slotMap<T>(raw: unknown, pick: (v: unknown) => T | null): SlotMap<T> {
  const out: SlotMap<T> = {}
  for (const [key, value] of Object.entries(obj(raw))) {
    const v = pick(value)
    if (isSlot(key) && v !== null) out[key] = v
  }
  return out
}

const folderOf = (v: unknown) => (typeof v === 'string' && v ? v : null)
const idOf = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null)
const countOf = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null)

/** An image row, bare (WASD) or wrapped as { image, tags } (A/B, keep/reject). */
export function readImage(raw: unknown): SortImage | null {
  const outer = obj(raw)
  const img = typeof outer.id === 'number' ? outer : obj(outer.image)
  if (typeof img.id !== 'number') return null
  const gen = readGeneration({
    metadata_json: text(img.metadata_json),
    checkpoint: text(img.checkpoint),
    loras: text(img.loras),
    width: typeof img.width === 'number' ? img.width : null,
    height: typeof img.height === 'number' ? img.height : null,
  })
  const aesthetic = typeof img.aesthetic_score === 'number' ? img.aesthetic_score : null
  return { id: img.id, filename: String(img.filename ?? ''), path: String(img.path ?? ''), gen, aesthetic }
}

function readMode(raw: unknown): SortMode {
  return raw === 'bracket' || raw === 'cull' ? raw : 'slot'
}

function readDecisions(raw: unknown): Record<number, Decision> {
  const out: Record<number, Decision> = {}
  for (const [id, d] of Object.entries(obj(raw))) {
    const n = Number(id)
    if (Number.isInteger(n) && n > 0 && (d === 'keep' || d === 'reject')) out[n] = d
  }
  return out
}

/** The counters every session answer carries (kept from `prev` when an answer leaves them out). */
function readFlags(p: Record<string, unknown>, prev: SessionView | null) {
  return {
    counts: 'slot_counts' in p ? slotMap(p.slot_counts, countOf) : (prev?.counts ?? {}),
    skipped: num(p.skipped_count, prev?.skipped ?? 0),
    canUndo: typeof p.undo_available === 'boolean' ? p.undo_available : (prev?.canUndo ?? false),
    canRedo: typeof p.redo_available === 'boolean' ? p.redo_available : (prev?.canRedo ?? false),
    libraryId: 'library_id' in p ? text(p.library_id) : (prev?.libraryId ?? null),
    libraryMixed: typeof p.library_mixed === 'boolean' ? p.library_mixed : (prev?.libraryMixed ?? false),
  }
}

function readDuel(p: Record<string, unknown>): Duel | null {
  const a = readImage(p.champion)
  const b = readImage(p.challenger)
  if (!a || !b) return null
  return { a, b, aIndex: num(p.champion_index, 0), bIndex: num(p.challenger_index, num(p.index, 1)) }
}

/** GET /api/sort/current as the page's session ('none' when nothing is saved). */
export function readSession(payload: unknown): SessionView | 'none' {
  const p = obj(payload)
  if (p.active === false) return 'none'
  const mode = readMode(p.mode)
  const ids = idList(p.image_ids) ?? []
  const total = num(p.total, ids.length)
  // An old backend answers a finished session with only { done, mode }: nothing to show.
  if (p.done === true && total === 0) return 'none'
  const done = p.done === true
  const duel = mode === 'bracket' && !done ? readDuel(p) : null
  return {
    mode,
    ids,
    total,
    index: done ? total : Math.min(num(p.index, 0), total),
    image: done ? null : (duel?.b ?? readImage(p.image)),
    folders: slotMap(p.folders, folderOf),
    collections: slotMap(p.collection_slots, idOf),
    operation: p.operation_mode === 'copy' ? 'copy' : 'move',
    ...readFlags(p, null),
    duel,
    winner: mode === 'bracket' && done ? readImage(p.winner) : null,
    decisions: readDecisions(p.decisions),
  }
}

/** The image that is up: its id from the session's order, its details only when they belong to it. */
export function upNow(view: SessionView): { id: number; image: SortImage | null } | null {
  const id = view.ids[view.index] ?? view.image?.id
  if (id === undefined || isFinished(view)) return null
  return { id, image: view.image?.id === id ? view.image : null }
}

export const isFinished = (view: SessionView): boolean => view.index >= view.total
export const leftToSort = (view: SessionView): number => Math.max(0, view.total - view.index)
export const isOpen = (s: SortState['session']): s is SessionView => s !== null && s !== 'none'

/** An unfinished session a new one would replace (any mode). */
export function unfinished(s: SortState['session']): SessionView | null {
  return isOpen(s) && !isFinished(s) ? s : null
}

/** The sort's images are not (only) in the library open now. */
export function isOtherLibrary(view: SessionView, openLibrary: string): boolean {
  return view.libraryMixed || (view.libraryId !== null && view.libraryId !== openLibrary)
}

/** What "keep sorting the other library's images" was said about: this sort, seen from this open library. */
export function crossLibraryKey(view: SessionView, openLibrary: string): string {
  return JSON.stringify([view.mode, view.total, view.ids[0] ?? null, view.libraryId, view.libraryMixed, openLibrary])
}

/** Keys and buttons wait while the sort belongs to another library and the user has not said to go on (`ok`: what they said it about). */
export function awaitsLibraryOk(view: SessionView, openLibrary: string, ok: string | null): boolean {
  return isOtherLibrary(view, openLibrary) && ok !== crossLibraryKey(view, openLibrary)
}

/** Slots with somewhere to send an image. */
export function usableSlots(view: Pick<SessionView, 'folders' | 'collections'>): SlotKey[] {
  return SLOT_KEYS.filter((k) => view.folders[k] || view.collections[k])
}

const FORWARD: Record<SortMode, SortAction['kind'][]> = {
  slot: ['slot', 'skip'],
  bracket: ['pick', 'skip'],
  cull: ['keep', 'reject', 'skip'],
}

/** A key that moves the sort on (not undo or redo). */
export const isForward = (action: SortAction): boolean => action.kind !== 'undo' && action.kind !== 'redo'

/** A key press: queued when it can do something, or the reason it cannot. */
export function press(state: SortState, action: SortAction): SortState {
  const view = state.session
  if (!isOpen(view)) return state
  if (isForward(action) && !FORWARD[view.mode].includes(action.kind)) return state
  const done = isFinished(view) && state.queue.length === 0 && !state.sending
  if (done && isForward(action)) return state
  if (action.kind === 'slot' && !view.folders[action.slot] && !view.collections[action.slot]) {
    return { ...state, error: { kind: 'unset', slot: action.slot } }
  }
  return { ...state, queue: [...state.queue, action], error: null }
}

/** The request for an action: POST /api/sort/action?action=…&folder_key=… */
export function requestFor(view: SessionView, action: SortAction): { action: string; folder_key?: SlotKey } {
  if (action.kind === 'slot') return { action: view.collections[action.slot] ? 'collect' : 'move', folder_key: action.slot }
  if (action.kind === 'pick') return { action: action.side === 'a' ? 'champion' : 'challenger' }
  return { action: action.kind }
}

/** Take the next queued action to send (null while one is out or nothing waits). */
export function takeNext(state: SortState): { state: SortState; action: SortAction } | null {
  const [action, ...rest] = state.queue
  if (state.sending || !action) return null
  return { state: { ...state, queue: rest, sending: true }, action }
}

/** A request that failed: say why and drop the keys pressed after it (they were meant for images that did not move on). */
export function failed(state: SortState, reason: string): SortState {
  return { ...state, sending: false, queue: [], error: { kind: 'failed', reason } }
}

const NOTHING = new Set(['no_history', 'no_redo', 'nothing_to_undo', 'nothing_to_redo'])

/** An answer that did not move the session: an error, or nothing left to undo or redo. */
export function isRefusal(payload: unknown): boolean {
  const p = obj(payload)
  return typeof p.error === 'string' || NOTHING.has(String(p.status))
}

function lastOf(action: SortAction, p: Record<string, unknown>, view: SessionView): LastAction {
  if (action.kind === 'slot') return { kind: 'slot', slot: action.slot, collect: !!view.collections[action.slot] }
  if (action.kind === 'pick') return { kind: 'pick', side: action.side }
  if (action.kind !== 'undo') return { kind: action.kind }
  const undone = p.undone_action ?? p.decision
  return { kind: 'undo', what: undone === 'skip' ? 'skip' : view.mode === 'slot' ? 'slot' : 'other' }
}

/** A key ignored for coming too soon stays said until a key counts again (the answer to the one before must not hide it). */
const stillTooSoon = (error: SortError | null): SortError | null => (error?.kind === 'cooldown' ? error : null)

/** Keys pressed past the last image have nothing left to act on. */
const afterDone = (queue: SortAction[], done: boolean) => (done ? queue.filter((a) => !isForward(a)) : queue)

function refused(state: SortState, view: SessionView, p: Record<string, unknown>): SortState {
  const session = { ...view, ...readFlags(p, view) }
  if (typeof p.error === 'string') return failed({ ...state, session }, p.error)
  return { ...state, sending: false, queue: [], session, error: { kind: 'nothing' } }
}

/** The backend's answer to a sent WASD action (POST /api/sort/action carries the next image). */
export function answered(state: SortState, action: SortAction, payload: unknown): SortState {
  const view = state.session
  if (!isOpen(view)) return { ...state, sending: false }
  const p = obj(payload)
  if (isRefusal(p)) return refused(state, view, p)
  const total = num(p.total, view.total)
  const done = p.done === true
  const next: SessionView = {
    ...view,
    ...readFlags(p, view),
    ids: idList(p.image_ids) ?? view.ids,
    total,
    index: done ? total : Math.min(num(p.index, num(p.current_index, view.index)), total),
    image: done ? null : (readImage(p.image) ?? view.image),
    folders: 'folders' in p ? slotMap(p.folders, folderOf) : view.folders,
  }
  return { ...state, queue: afterDone(state.queue, done), sending: false, session: next, error: stillTooSoon(state.error), last: lastOf(action, p, view) }
}

/**
 * A/B and keep/reject answer an action with flags only; the page then reads
 * the session again (`current`, GET /api/sort/current) to show the next pair or image.
 */
export function reloaded(state: SortState, action: SortAction, payload: unknown, current: unknown): SortState {
  const view = state.session
  if (!isOpen(view)) return { ...state, sending: false }
  const p = obj(payload)
  if (isRefusal(p)) return refused(state, view, p)
  const next = readSession(current)
  if (next === 'none') return { ...state, sending: false, queue: [], session: 'none' }
  const done = isFinished(next)
  return { ...state, queue: afterDone(state.queue, done), sending: false, session: next, error: stillTooSoon(state.error), last: lastOf(action, p, view) }
}

/** One row of the finished summary per slot that was used. */
export interface SummaryRow {
  slot: SlotKey
  folder: string | null
  collection: number | null
  count: number
}

export function summary(view: SessionView): { rows: SummaryRow[]; sent: number } {
  const rows = SLOT_KEYS.filter((k) => view.folders[k] || view.collections[k] || view.counts[k]).map((slot) => ({
    slot,
    folder: view.folders[slot] ?? null,
    collection: view.collections[slot] ?? null,
    count: view.counts[slot] ?? 0,
  }))
  return { rows, sent: rows.reduce((n, r) => n + r.count, 0) }
}

/** Keep/reject: the ids behind each decision, in the session's order (by id once the order is not sent). */
export function decided(view: SessionView): Record<Decision, number[]> {
  const out: Record<Decision, number[]> = { keep: [], reject: [] }
  const known = view.ids.filter((id) => id in view.decisions)
  const order = known.length ? known : Object.keys(view.decisions).map(Number)
  for (const id of order) {
    const d = view.decisions[id]
    if (d) out[d].push(id)
  }
  return out
}
