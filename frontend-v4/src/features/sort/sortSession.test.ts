import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answered,
  failed,
  INITIAL_STATE,
  isFinished,
  keyAction,
  press,
  readSession,
  requestFor,
  summary,
  takeNext,
  unfinished,
  upNow,
  type SessionView,
  type SortAction,
  type SortState,
} from './sortSession'
import { EMPTY_SETUP, hasFolder, loadSetup, saveSetup, startBody, withFolder } from './savedSetup'

const current = (over: Record<string, unknown> = {}) => ({
  image: { id: 11, filename: 'a.png', path: 'C:/in/a.png' },
  tags: [],
  mode: 'slot',
  index: 0,
  total: 3,
  remaining: 3,
  image_ids: [11, 12, 13],
  folders: { w: 'D:/keep', a: 'D:/later' },
  collection_slots: {},
  operation_mode: 'move',
  sorted_count: 0,
  skipped_count: 0,
  collected_count: 0,
  slot_counts: {},
  undo_available: false,
  redo_available: false,
  restore_failure: null,
  ...over,
})

const open = (over: Record<string, unknown> = {}): SortState => ({ ...INITIAL_STATE, session: readSession(current(over)) })
const view = (s: SortState) => s.session as SessionView

/** Send the queued actions one by one, answering each with `answer`. */
function run(state: SortState, answer: (action: SortAction, s: SortState) => unknown): SortState {
  let s = state
  for (let next = takeNext(s); next; next = takeNext(s)) s = answered(next.state, next.action, answer(next.action, next.state))
  return s
}

describe('reading the saved session (restore after a reload)', () => {
  it('reads an unfinished WASD session', () => {
    const v = readSession(current({ index: 1, slot_counts: { w: 1 }, skipped_count: 0, undo_available: true }))
    expect(v).toMatchObject({ mode: 'slot', ids: [11, 12, 13], total: 3, index: 1, folders: { w: 'D:/keep', a: 'D:/later' } })
    expect((v as SessionView).counts).toEqual({ w: 1 })
    expect((v as SessionView).canUndo).toBe(true)
    expect(unfinished(v)).not.toBeNull()
  })

  it('reads a finished session as its summary', () => {
    const v = readSession({ done: true, mode: 'slot', index: 3, total: 3, image_ids: [1, 2, 3], folders: { d: 'D:/x' }, operation_mode: 'copy', slot_counts: { d: 2 }, skipped_count: 1, undo_available: true })
    expect(v).not.toBe('none')
    const s = v as SessionView
    expect(isFinished(s)).toBe(true)
    expect(s.operation).toBe('copy')
    expect(unfinished(v)).toBeNull()
    expect(summary(s)).toEqual({ rows: [{ slot: 'd', folder: 'D:/x', collection: null, count: 2 }], sent: 2 })
  })

  it('reads no session, and an old finished answer with nothing in it, as none', () => {
    expect(readSession({ active: false, done: true, image_ids: [], total: 0 })).toBe('none')
    expect(readSession({ done: true, message: 'All images sorted', mode: 'slot' })).toBe('none')
  })

  it('keeps an A/B or keep/reject session from V3.5 recognisable', () => {
    const v = readSession({ active: true, done: false, mode: 'bracket', index: 4, total: 9, image_ids: [] })
    expect(v).toMatchObject({ mode: 'bracket', index: 4, total: 9 })
    expect(press({ ...INITIAL_STATE, session: v }, { kind: 'slot', slot: 'w' }).queue).toEqual([])
  })

  it('shows the image the session order says is up, with details only when they are its own', () => {
    const v = readSession(current({ index: 1, image: { id: 12, filename: 'b.png', path: 'C:/in/b.png' } })) as SessionView
    expect(upNow(v)).toEqual({ id: 12, image: { id: 12, filename: 'b.png', path: 'C:/in/b.png' } })
    expect(upNow({ ...v, image: { id: 11, filename: 'a.png', path: '' } })).toEqual({ id: 12, image: null })
    expect(upNow({ ...v, index: 3 })).toBeNull()
  })

  it('ignores slots it does not know and junk values', () => {
    const v = readSession(current({ folders: { w: 'D:/keep', x: 'D:/nope', a: '' }, collection_slots: { s: 7, d: null }, slot_counts: { w: 2, q: 5 } })) as SessionView
    expect(v.folders).toEqual({ w: 'D:/keep' })
    expect(v.collections).toEqual({ s: 7 })
    expect(v.counts).toEqual({ w: 2 })
  })
})

describe('keys', () => {
  it('maps W A S D to the slots by key position, whatever the layout or input method', () => {
    expect(keyAction({ key: 'w', code: 'KeyW' })).toEqual({ kind: 'slot', slot: 'w' })
    expect(keyAction({ key: 'D', code: 'KeyD', shiftKey: true })).toEqual({ kind: 'slot', slot: 'd' })
    expect(keyAction({ key: 'Process', code: 'KeyA' })).toEqual({ kind: 'slot', slot: 'a' })
    expect(keyAction({ key: 's' })).toEqual({ kind: 'slot', slot: 's' })
  })

  it('skips with Space or the right arrow, undoes with Backspace, Z or Ctrl+Z, redoes with Y, Ctrl+Y or Ctrl+Shift+Z', () => {
    expect(keyAction({ key: ' ', code: 'Space' })).toEqual({ kind: 'skip' })
    expect(keyAction({ key: 'ArrowRight', code: 'ArrowRight' })).toEqual({ kind: 'skip' })
    expect(keyAction({ key: 'Backspace', code: 'Backspace' })).toEqual({ kind: 'undo' })
    expect(keyAction({ key: 'z', code: 'KeyZ' })).toEqual({ kind: 'undo' })
    expect(keyAction({ key: 'z', code: 'KeyZ', ctrlKey: true })).toEqual({ kind: 'undo' })
    expect(keyAction({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true })).toEqual({ kind: 'redo' })
    expect(keyAction({ key: 'y', code: 'KeyY', ctrlKey: true })).toEqual({ kind: 'redo' })
    expect(keyAction({ key: 'y', code: 'KeyY' })).toEqual({ kind: 'redo' })
  })

  it('leaves every other key alone (Ctrl K, Esc, the left arrow, Alt combos)', () => {
    expect(keyAction({ key: 'k', code: 'KeyK', ctrlKey: true })).toBeNull()
    expect(keyAction({ key: 'w', code: 'KeyW', ctrlKey: true })).toBeNull()
    expect(keyAction({ key: 'Escape', code: 'Escape' })).toBeNull()
    expect(keyAction({ key: 'ArrowLeft', code: 'ArrowLeft' })).toBeNull()
    expect(keyAction({ key: 'w', code: 'KeyW', altKey: true })).toBeNull()
    expect(keyAction({ key: 'Enter', code: 'Enter' })).toBeNull()
  })
})

describe('pressing keys during a session', () => {
  it('queues a slot key and sends move with the slot as folder key', () => {
    const s = press(open(), { kind: 'slot', slot: 'w' })
    expect(s.queue).toEqual([{ kind: 'slot', slot: 'w' }])
    expect(requestFor(view(s), { kind: 'slot', slot: 'w' })).toEqual({ action: 'move', folder_key: 'w' })
    expect(requestFor(view(s), { kind: 'skip' })).toEqual({ action: 'skip' })
  })

  it('refuses a key with no folder and says which key', () => {
    const s = press(open(), { kind: 'slot', slot: 'd' })
    expect(s.queue).toEqual([])
    expect(s.error).toEqual({ kind: 'unset', slot: 'd' })
  })

  it('sends a V3.5 collection slot as collect', () => {
    const s = open({ collection_slots: { s: 4 } })
    expect(press(s, { kind: 'slot', slot: 's' }).queue).toHaveLength(1)
    expect(requestFor(view(s), { kind: 'slot', slot: 's' })).toEqual({ action: 'collect', folder_key: 's' })
  })

  it('sends one action at a time, in the order pressed', () => {
    let s = press(press(open(), { kind: 'slot', slot: 'w' }), { kind: 'skip' })
    const first = takeNext(s)!
    expect(first.action).toEqual({ kind: 'slot', slot: 'w' })
    expect(takeNext(first.state)).toBeNull() // one is out
    s = answered(first.state, first.action, { image: { id: 12 }, index: 1, total: 3, slot_counts: { w: 1 }, skipped_count: 0, undo_available: true })
    expect(takeNext(s)!.action).toEqual({ kind: 'skip' })
  })

  it('moves on, counts per slot and skips, then finishes', () => {
    let s = open()
    for (const a of [{ kind: 'slot', slot: 'w' }, { kind: 'skip' }, { kind: 'slot', slot: 'a' }] as SortAction[]) s = press(s, a)
    const counts = { w: 0, a: 0 }
    let skipped = 0
    let index = 0
    s = run(s, (a) => {
      if (a.kind === 'slot') counts[a.slot as 'w' | 'a'] += 1
      if (a.kind === 'skip') skipped += 1
      index += 1
      const flags = { slot_counts: { ...counts }, skipped_count: skipped, undo_available: true }
      return index >= 3 ? { done: true, ...flags } : { image: { id: 11 + index }, index, total: 3, ...flags }
    })
    const v = view(s)
    expect(isFinished(v)).toBe(true)
    expect(v.counts).toEqual({ w: 1, a: 1 })
    expect(v.skipped).toBe(1)
    expect(s.last).toEqual({ kind: 'slot', slot: 'a', collect: false })
    expect(summary(v).sent).toBe(2)
  })

  it('undo goes back one image and takes the count back', () => {
    let s = open({ index: 2, image: { id: 13 }, slot_counts: { w: 1, a: 1 }, undo_available: true })
    s = press(s, { kind: 'undo' })
    s = run(s, () => ({ status: 'undone', undone_action: 'move', folder_key: 'a', image: { id: 12, filename: 'b.png' }, index: 1, total: 3, image_ids: [11, 12, 13], folders: { w: 'D:/keep', a: 'D:/later' }, slot_counts: { w: 1 }, undo_available: true, redo_available: true }))
    expect(view(s).index).toBe(1)
    expect(view(s).image?.id).toBe(12)
    expect(view(s).counts).toEqual({ w: 1 })
    expect(view(s).canRedo).toBe(true)
    expect(s.last).toEqual({ kind: 'undo', what: 'slot' })
  })

  it('undo works from the finished summary; slot keys there do nothing', () => {
    const done = { ...INITIAL_STATE, session: readSession({ done: true, index: 3, total: 3, image_ids: [1, 2, 3], folders: { w: 'D:/k' }, slot_counts: { w: 3 }, undo_available: true }) }
    expect(press(done, { kind: 'slot', slot: 'w' }).queue).toEqual([])
    expect(press(done, { kind: 'skip' }).queue).toEqual([])
    expect(press(done, { kind: 'undo' }).queue).toEqual([{ kind: 'undo' }])
  })

  it('drops keys pressed past the last image', () => {
    let s = open({ index: 2 })
    s = press(press(press(s, { kind: 'slot', slot: 'w' }), { kind: 'slot', slot: 'w' }), { kind: 'undo' })
    const first = takeNext(s)!
    s = answered(first.state, first.action, { done: true, slot_counts: { w: 1 }, undo_available: true })
    expect(isFinished(view(s))).toBe(true)
    expect(s.queue).toEqual([{ kind: 'undo' }])
  })

  it('an error answer keeps the image, says why and drops the rest of the queue', () => {
    let s = press(press(open(), { kind: 'slot', slot: 'w' }), { kind: 'slot', slot: 'a' })
    const first = takeNext(s)!
    s = answered(first.state, first.action, { error: 'Image file not found on disk', operation_mode: 'move', slot_counts: {}, undo_available: false })
    expect(view(s).index).toBe(0)
    expect(s.error).toEqual({ kind: 'failed', reason: 'Image file not found on disk' })
    expect(s.queue).toEqual([])
    expect(s.sending).toBe(false)
  })

  it('a failed request (undo refused by the server) drops the queue too', () => {
    const s = failed({ ...press(open(), { kind: 'skip' }), sending: true }, 'Could not undo last action')
    expect(s).toMatchObject({ sending: false, queue: [], error: { kind: 'failed', reason: 'Could not undo last action' } })
  })

  it('nothing to undo is said, not an error', () => {
    let s = press(open(), { kind: 'undo' })
    const first = takeNext(s)!
    s = answered(first.state, first.action, { status: 'no_history', message: 'Nothing to undo', undo_available: false })
    expect(s.error).toEqual({ kind: 'nothing' })
  })
})

describe('the setup, remembered per library', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('restores the folders and move/copy of the same library only', () => {
    const setup = withFolder(withFolder({ ...EMPTY_SETUP, operation: 'copy' }, 'w', 'D:/keep'), 'd', 'D:/trash')
    saveSetup('main', setup)
    expect(loadSetup('main')).toEqual({ folders: { w: 'D:/keep', d: 'D:/trash' }, operation: 'copy' })
    expect(loadSetup('other')).toEqual(EMPTY_SETUP)
  })

  it('survives junk and clears a folder with null', () => {
    store.set('sd-v4-sort-setup:main', '{not json')
    expect(loadSetup('main')).toEqual(EMPTY_SETUP)
    store.set('sd-v4-sort-setup:main', JSON.stringify({ folders: { w: 5, a: 'D:/a', q: 'D:/q' }, operation: 'teleport' }))
    expect(loadSetup('main')).toEqual({ folders: { a: 'D:/a' }, operation: 'move' })
    const cleared = withFolder(loadSetup('main'), 'a', null)
    expect(cleared.folders).toEqual({})
    expect(hasFolder(cleared)).toBe(false)
  })

  it('starts with the images in order and only the keys that have a folder', () => {
    const setup = withFolder(withFolder(EMPTY_SETUP, 's', 'D:/s'), 'w', 'D:/w')
    expect(startBody([5, 3, 9], setup, false)).toMatchObject({
      image_ids: [5, 3, 9],
      folders: { w: 'D:/w', s: 'D:/s' },
      operation_mode: 'move',
      replace_existing: false,
      mode: 'slot',
    })
    expect(Object.keys(startBody([1], setup, true).folders)).toEqual(['w', 's'])
  })
})
