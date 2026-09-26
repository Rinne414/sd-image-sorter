// The Sort tab's session as the page sees it: which image is up, where each
// key sends it, how many went where. The backend owns the session (one saved
// session, restored after a reload or a restart); this module reads its
// answers and keeps key presses in order while they go out one at a time.
// Pure: sortStore.ts does the requests.

export const SLOT_KEYS = ['w', 'a', 's', 'd'] as const
export type SlotKey = (typeof SLOT_KEYS)[number]
export type FileOperation = 'move' | 'copy'
/** slot = WASD into folders; bracket (A/B) and cull (keep/reject) are V3.5 modes V4 does not run yet. */
export type SortMode = 'slot' | 'bracket' | 'cull'

export type SortAction = { kind: 'slot'; slot: SlotKey } | { kind: 'skip' } | { kind: 'undo' } | { kind: 'redo' }

export type SlotMap<T> = Partial<Record<SlotKey, T>>

export interface SortImage {
  id: number
  filename: string
  path: string
}

export interface SessionView {
  mode: SortMode
  ids: number[]
  total: number
  /** Position of the image that is up; `total` once every image is done. */
  index: number
  image: SortImage | null
  folders: SlotMap<string>
  /** Slots V3.5 pointed at a collection: the key adds the image there and no file moves. */
  collections: SlotMap<number>
  operation: FileOperation
  counts: SlotMap<number>
  skipped: number
  canUndo: boolean
  canRedo: boolean
}

/** What the last answered key did, for the line under the picture. */
export type LastAction =
  | { kind: 'slot'; slot: SlotKey; collect: boolean }
  | { kind: 'skip' }
  | { kind: 'undo'; what: 'slot' | 'skip' }
  | { kind: 'redo' }

export type SortError = { kind: 'unset'; slot: SlotKey } | { kind: 'failed'; reason: string } | { kind: 'nothing' }

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

function readImage(raw: unknown): SortImage | null {
  const img = obj(raw)
  if (typeof img.id !== 'number') return null
  return { id: img.id, filename: String(img.filename ?? ''), path: String(img.path ?? '') }
}

function readMode(raw: unknown): SortMode {
  return raw === 'bracket' || raw === 'cull' ? raw : 'slot'
}

/** The counters every session answer carries (kept from `prev` when an answer leaves them out). */
function readFlags(p: Record<string, unknown>, prev: SessionView | null) {
  return {
    counts: 'slot_counts' in p ? slotMap(p.slot_counts, countOf) : (prev?.counts ?? {}),
    skipped: num(p.skipped_count, prev?.skipped ?? 0),
    canUndo: typeof p.undo_available === 'boolean' ? p.undo_available : (prev?.canUndo ?? false),
    canRedo: typeof p.redo_available === 'boolean' ? p.redo_available : (prev?.canRedo ?? false),
  }
}

/** GET /api/sort/current as the page's session ('none' when nothing is saved). */
export function readSession(payload: unknown): SessionView | 'none' {
  const p = obj(payload)
  if (p.active === false) return 'none'
  const ids = Array.isArray(p.image_ids) ? p.image_ids.filter((x): x is number => typeof x === 'number') : []
  const total = num(p.total, ids.length)
  // An old backend answers a finished session with only { done, mode }: nothing to show.
  if (p.done === true && total === 0) return 'none'
  const done = p.done === true
  return {
    mode: readMode(p.mode),
    ids,
    total,
    index: done ? total : Math.min(num(p.index, 0), total),
    image: done ? null : readImage(p.image),
    folders: slotMap(p.folders, folderOf),
    collections: slotMap(p.collection_slots, idOf),
    operation: p.operation_mode === 'copy' ? 'copy' : 'move',
    ...readFlags(p, null),
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

/** Slots with somewhere to send an image. */
export function usableSlots(view: Pick<SessionView, 'folders' | 'collections'>): SlotKey[] {
  return SLOT_KEYS.filter((k) => view.folders[k] || view.collections[k])
}

export interface KeyLike {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

const SLOT_CODES: Record<string, SlotKey> = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd' }

/**
 * The key's meaning on the Sort tab. By position (e.code) first, so WASD works
 * with any keyboard layout or a Chinese input method switched on.
 */
export function keyAction(e: KeyLike): SortAction | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const code = e.code ?? ''
  if (e.altKey) return null
  if (e.ctrlKey || e.metaKey) {
    if (code === 'KeyZ' || key === 'z') return e.shiftKey ? { kind: 'redo' } : { kind: 'undo' }
    if (code === 'KeyY' || key === 'y') return { kind: 'redo' }
    return null
  }
  const slot = SLOT_CODES[code] ?? (isSlot(key) ? key : null)
  if (slot) return { kind: 'slot', slot }
  if (code === 'Space' || key === ' ' || key === 'ArrowRight') return { kind: 'skip' }
  if (key === 'Backspace' || code === 'KeyZ' || key === 'z') return { kind: 'undo' }
  if (code === 'KeyY' || key === 'y') return { kind: 'redo' }
  return null
}

/** A key press: queued when it can do something, or the reason it cannot. */
export function press(state: SortState, action: SortAction): SortState {
  const view = state.session
  if (!isOpen(view) || view.mode !== 'slot') return state
  const done = isFinished(view) && state.queue.length === 0 && !state.sending
  if (done && (action.kind === 'slot' || action.kind === 'skip')) return state
  if (action.kind === 'slot' && !view.folders[action.slot] && !view.collections[action.slot]) {
    return { ...state, error: { kind: 'unset', slot: action.slot } }
  }
  return { ...state, queue: [...state.queue, action], error: null }
}

/** The request for an action: POST /api/sort/action?action=…&folder_key=… */
export function requestFor(view: SessionView, action: SortAction): { action: string; folder_key?: SlotKey } {
  if (action.kind !== 'slot') return { action: action.kind }
  return { action: view.collections[action.slot] ? 'collect' : 'move', folder_key: action.slot }
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

function lastOf(action: SortAction, p: Record<string, unknown>, view: SessionView): LastAction {
  if (action.kind === 'slot') return { kind: 'slot', slot: action.slot, collect: !!view.collections[action.slot] }
  if (action.kind === 'undo') return { kind: 'undo', what: p.undone_action === 'skip' ? 'skip' : 'slot' }
  return { kind: action.kind }
}

/** The backend's answer to a sent action (POST /api/sort/action). */
export function answered(state: SortState, action: SortAction, payload: unknown): SortState {
  const view = state.session
  if (!isOpen(view)) return { ...state, sending: false }
  const p = obj(payload)
  const flags = readFlags(p, view)
  if (typeof p.error === 'string') return failed({ ...state, session: { ...view, ...flags } }, p.error)
  if (p.status === 'no_history' || p.status === 'no_redo') {
    return { ...state, sending: false, queue: [], session: { ...view, ...flags }, error: { kind: 'nothing' } }
  }
  const ids = Array.isArray(p.image_ids) ? p.image_ids.filter((x): x is number => typeof x === 'number') : view.ids
  const total = num(p.total, view.total)
  const done = p.done === true
  const next: SessionView = {
    ...view,
    ...flags,
    ids,
    total,
    index: done ? total : Math.min(num(p.index, num(p.current_index, view.index)), total),
    image: done ? null : (readImage(p.image) ?? view.image),
    folders: 'folders' in p ? slotMap(p.folders, folderOf) : view.folders,
  }
  // Keys pressed past the last image have nothing left to act on.
  const queue = done ? state.queue.filter((a) => a.kind === 'undo' || a.kind === 'redo') : state.queue
  return { ...state, queue, sending: false, session: next, error: null, last: lastOf(action, p, view) }
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
