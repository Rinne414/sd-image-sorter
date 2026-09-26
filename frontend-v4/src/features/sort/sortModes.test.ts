import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readGeneration } from '../../lib/meta'
import { EMPTY_SETUP, MIN_IMAGES, setupReady, startBody } from './savedSetup'
import {
  compare,
  containedRect,
  facts,
  heldRounds,
  keyAction,
  perMinute,
  round,
  samplerKey,
  spotOnPicture,
  tooSoon,
  zoomOrigin,
} from './sortModes'
import { EMPTY_RULE } from './rules'
import { clampCooldown, deletePreset, loadPresets, presetSetup, savePreset } from './sortPrefs'
import {
  decided,
  INITIAL_STATE,
  isFinished,
  press,
  readSession,
  reloaded,
  requestFor,
  takeNext,
  type SessionView,
  type SortAction,
  type SortState,
} from './sortSession'

const row = (id: number, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id,
  filename: `${id}.png`,
  path: `C:/in/${id}.png`,
  metadata_json: JSON.stringify({ _parsed: { generation_params: params } }),
  checkpoint: null,
  loras: null,
  width: 832,
  height: 1216,
  ...extra,
})

const bracket = (over: Record<string, unknown> = {}) => ({
  active: true,
  done: false,
  mode: 'bracket',
  champion: { image: row(1, { sampler: 'Euler a', cfg_scale: 5 }), tags: [] },
  challenger: { image: row(3, { sampler: 'k_euler_ancestral', cfg_scale: 7 }), tags: [] },
  champion_index: 0,
  challenger_index: 2,
  index: 2,
  total: 4,
  image_ids: [1, 2, 3, 4],
  skipped_count: 1,
  undo_available: true,
  redo_available: false,
  library_id: 'main',
  ...over,
})

const cull = (over: Record<string, unknown> = {}) => ({
  active: true,
  done: false,
  mode: 'cull',
  image: { image: row(12), tags: [] },
  index: 2,
  total: 4,
  kept: 1,
  rejected: 1,
  image_ids: [10, 11, 12, 13],
  decisions: { '11': 'reject', '10': 'keep' },
  undo_available: true,
  library_id: 'other',
  ...over,
})

const open = (payload: unknown): SortState => ({ ...INITIAL_STATE, session: readSession(payload) })
const view = (s: SortState) => s.session as SessionView

describe('A/B showdown session', () => {
  it('reads the pair, the round and how long A has held', () => {
    const v = readSession(bracket()) as SessionView
    expect(v.mode).toBe('bracket')
    expect(v.duel?.a.id).toBe(1)
    expect(v.duel?.b.id).toBe(3)
    expect(v.image?.id).toBe(3)
    expect(heldRounds(v.duel!)).toBe(1)
    expect(round(v.index, v.total)).toEqual({ at: 2, of: 3 })
    expect(v.libraryId).toBe('main')
  })

  it('reads the finished showdown as its winner', () => {
    const v = readSession({ active: true, done: true, mode: 'bracket', winner: { image: row(3), tags: [] }, total: 4, undo_available: true }) as SessionView
    expect(isFinished(v)).toBe(true)
    expect(v.winner?.id).toBe(3)
    expect(v.duel).toBeNull()
  })

  it('takes only its own keys: ← / A keep A, → / D take B, Space / ↑ / W skip', () => {
    expect(keyAction({ key: 'ArrowLeft' }, 'bracket')).toEqual({ kind: 'pick', side: 'a' })
    expect(keyAction({ key: 'a', code: 'KeyA' }, 'bracket')).toEqual({ kind: 'pick', side: 'a' })
    expect(keyAction({ key: 'ArrowRight' }, 'bracket')).toEqual({ kind: 'pick', side: 'b' })
    expect(keyAction({ key: 'Process', code: 'KeyD' }, 'bracket')).toEqual({ kind: 'pick', side: 'b' })
    expect(keyAction({ key: ' ', code: 'Space' }, 'bracket')).toEqual({ kind: 'skip' })
    expect(keyAction({ key: 'w', code: 'KeyW' }, 'bracket')).toEqual({ kind: 'skip' })
    expect(keyAction({ key: 's', code: 'KeyS' }, 'bracket')).toBeNull()
    expect(keyAction({ key: 'Backspace' }, 'bracket')).toEqual({ kind: 'undo' })
    const s = open(bracket())
    expect(press(s, { kind: 'slot', slot: 'w' }).queue).toEqual([])
    expect(press(s, { kind: 'keep' }).queue).toEqual([])
    expect(requestFor(view(s), { kind: 'pick', side: 'a' })).toEqual({ action: 'champion' })
    expect(requestFor(view(s), { kind: 'pick', side: 'b' })).toEqual({ action: 'challenger' })
  })

  it('shows the next pair from the session read after the flags-only answer', () => {
    let s = press(open(bracket()), { kind: 'pick', side: 'b' })
    const next = takeNext(s)!
    s = reloaded(next.state, next.action, { status: 'ok', done: false, champion_index: 2, challenger_index: 3 }, bracket({ champion: { image: row(3) }, challenger: { image: row(4) }, champion_index: 2, challenger_index: 3, index: 3 }))
    expect(view(s).duel?.a.id).toBe(3)
    expect(view(s).duel?.b.id).toBe(4)
    expect(s.last).toEqual({ kind: 'pick', side: 'b' })
    expect(s.sending).toBe(false)
  })

  it('says so when there is nothing to undo, without reading the session again', () => {
    let s = press(open(bracket({ undo_available: false })), { kind: 'undo' })
    const next = takeNext(s)!
    s = reloaded(next.state, next.action, { status: 'nothing_to_undo', undo_available: false }, null)
    expect(s.error).toEqual({ kind: 'nothing' })
    expect(view(s).duel?.b.id).toBe(3)
  })
})

describe('keep / reject session', () => {
  it('reads the picture, the decisions in the session order and the tally', () => {
    const v = readSession(cull()) as SessionView
    expect(v.mode).toBe('cull')
    expect(v.image?.id).toBe(12)
    expect(decided(v)).toEqual({ keep: [10], reject: [11] })
    expect(v.libraryId).toBe('other')
  })

  it('keeps with → D K, rejects with ← A X, skips with Space ↑ ↓ W S', () => {
    for (const k of [{ key: 'ArrowRight' }, { key: 'd', code: 'KeyD' }, { key: 'k', code: 'KeyK' }]) expect(keyAction(k, 'cull')).toEqual({ kind: 'keep' })
    for (const k of [{ key: 'ArrowLeft' }, { key: 'a', code: 'KeyA' }, { key: 'x', code: 'KeyX' }]) expect(keyAction(k, 'cull')).toEqual({ kind: 'reject' })
    for (const k of [{ key: ' ', code: 'Space' }, { key: 'ArrowUp' }, { key: 'ArrowDown' }, { key: 'w', code: 'KeyW' }, { key: 's', code: 'KeyS' }]) {
      expect(keyAction(k, 'cull')).toEqual({ kind: 'skip' })
    }
    expect(keyAction({ key: 'z', code: 'KeyZ', ctrlKey: true }, 'cull')).toEqual({ kind: 'undo' })
    expect(requestFor(view(open(cull())), { kind: 'reject' })).toEqual({ action: 'reject' })
  })

  it('an undo brings the decision back off the tally', () => {
    let s = press(open(cull()), { kind: 'undo' })
    const next = takeNext(s)!
    s = reloaded(next.state, next.action, { status: 'undone', decision: 'reject', image_id: 11 }, cull({ index: 1, image: { image: row(11) }, decisions: { '10': 'keep' } }))
    expect(decided(view(s))).toEqual({ keep: [10], reject: [] })
    expect(view(s).image?.id).toBe(11)
    expect(s.last).toEqual({ kind: 'undo', what: 'other' })
  })

  it('finishing drops keys pressed past the last image, keeps undo', () => {
    let s = open(cull({ index: 3, image: { image: row(13) } }))
    for (const a of [{ kind: 'keep' }, { kind: 'keep' }, { kind: 'undo' }] as SortAction[]) s = press(s, a)
    const next = takeNext(s)!
    s = reloaded(next.state, next.action, { status: 'ok', done: true }, cull({ done: true, image: null, index: 4, decisions: { '10': 'keep', '11': 'reject', '13': 'keep' } }))
    expect(isFinished(view(s))).toBe(true)
    expect(s.queue).toEqual([{ kind: 'undo' }])
    expect(decided(view(s)).keep).toEqual([10, 13])
  })
})

describe('A/B: only the differences', () => {
  const gen = (params: Record<string, unknown>, checkpoint: string | null = null) =>
    readGeneration({ metadata_json: JSON.stringify({ _parsed: { generation_params: params } }), checkpoint, loras: null, width: 832, height: 1216 })

  it('treats the same sampler written by different tools as the same', () => {
    expect(samplerKey('DPM++ 2M')).toBe(samplerKey('dpmpp_2m'))
    expect(samplerKey('k_euler_ancestral')).toBe(samplerKey('Euler a'))
    expect(samplerKey('Euler')).not.toBe(samplerKey('Euler a'))
  })

  it('lists what differs and names what is the same', () => {
    const c = compare(gen({ sampler: 'Euler a', cfg_scale: 5, steps: 28, seed: 1 }, 'D:/m/noob.safetensors'), gen({ sampler: 'k_euler_ancestral', cfg_scale: 7, steps: 28, seed: 2 }, 'D:/m/noob.safetensors'))
    expect(c.diffs).toEqual([
      { key: 'cfg', a: '5', b: '7' },
      { key: 'seed', a: '1', b: '2' },
    ])
    expect(c.same).toEqual(['sampler', 'steps', 'model', 'size'])
    expect(c.noParams).toBe(false)
  })

  it('does not call two images without settings "the same"', () => {
    const c = compare(gen({}), gen({}))
    expect(c.diffs).toEqual([])
    expect(c.noParams).toBe(true)
  })

  it('prints each picture\'s facts in reading order', () => {
    const v = readSession(bracket()) as SessionView
    expect(facts({ ...v.duel!.a, aesthetic: 6.25 })).toEqual([
      ['sampler', 'Euler a'],
      ['cfg', '5'],
      ['size', '832×1216'],
      ['aesthetic', '6.3'],
    ])
  })
})

describe('A/B: zooming both to the same spot', () => {
  it('finds where a fitted picture sits in its box', () => {
    expect(containedRect(1000, 500, 400, 400)).toEqual({ left: 0, top: 100, width: 400, height: 200 })
    expect(containedRect(0, 500, 400, 400)).toBeNull()
  })

  it('maps the pointer to a spot on the picture and back to each box', () => {
    const spot = spotOnPicture(1000, 500, 400, 400, 300, 150)
    expect(spot).toEqual({ x: 0.75, y: 0.25 })
    // the same spot on a tall picture in a wide box lands elsewhere in that box
    expect(zoomOrigin(spot, 500, 1000, 400, 400)).toEqual({ x: 62.5, y: 25 })
    expect(spotOnPicture(1000, 500, 400, 400, -5, 999)).toEqual({ x: 0, y: 1 })
  })
})

describe('the pace of the keys', () => {
  it('ignores a key sooner than the cooldown after the last one that counted', () => {
    expect(tooSoon(null, 1000, 300)).toBe(false)
    expect(tooSoon(1000, 1200, 300)).toBe(true)
    expect(tooSoon(1000, 1300, 300)).toBe(false)
    expect(tooSoon(1000, 1001, 0)).toBe(false)
  })

  it('a key ignored for coming too soon stays said when the answer to the key before arrives', () => {
    let s = press(open(cull()), { kind: 'keep' })
    const next = takeNext(s)!
    s = { ...next.state, error: { kind: 'cooldown' } }
    s = reloaded(s, next.action, { status: 'ok' }, cull({ index: 3, image: { image: row(13) } }))
    expect(s.error).toEqual({ kind: 'cooldown' })
    expect(press(s, { kind: 'keep' }).error).toBeNull()
  })

  it('keeps the cooldown between 100 and 2000 ms, or off', () => {
    expect(clampCooldown(0)).toBe(0)
    expect(clampCooldown(-5)).toBe(0)
    expect(clampCooldown(NaN)).toBe(0)
    expect(clampCooldown(40)).toBe(100)
    expect(clampCooldown(5000)).toBe(2000)
    expect(clampCooldown(333.4)).toBe(333)
  })

  it('tells the pace over the last half minute once there is enough', () => {
    expect(perMinute([1000, 2000], 3000)).toBeNull()
    expect(perMinute([0, 10_000, 20_000, 30_000], 30_000)).toBe(8)
    expect(perMinute([0, 1000, 2000, 60_000, 61_000, 62_000], 62_000)).toBe(90)
  })
})

describe('setups and presets', () => {
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

  it('A/B and keep/reject start without folders and never ask to move files', () => {
    const setup = { ...EMPTY_SETUP, mode: 'bracket' as const, folders: { w: 'D:/keep' }, operation: 'move' as const }
    expect(setupReady(setup)).toBe(true)
    expect(setupReady(EMPTY_SETUP)).toBe(false)
    expect(MIN_IMAGES.bracket).toBe(2)
    expect(startBody([1, 2], setup, false)).toMatchObject({ mode: 'bracket', folders: {}, operation_mode: 'copy' })
  })

  it('saves, replaces in place, lists per library and deletes presets', () => {
    savePreset('main', 'daily', { mode: 'slot', folders: { w: 'D:/keep' }, operation: 'copy', rule: EMPTY_RULE, more: [], favorites: [] })
    savePreset('main', 'cull', { mode: 'cull', folders: {}, operation: 'move', rule: EMPTY_RULE, more: [], favorites: [] })
    savePreset('main', ' daily ', { mode: 'slot', folders: { a: 'D:/later' }, operation: 'move', rule: EMPTY_RULE, more: [], favorites: [] })
    const list = loadPresets('main')
    expect(list.map((p) => p.name)).toEqual(['daily', 'cull'])
    expect(presetSetup(list[0]!)).toEqual({ mode: 'slot', folders: { a: 'D:/later' }, operation: 'move', rule: EMPTY_RULE, more: [], favorites: [] })
    expect(loadPresets('other')).toEqual([])
    expect(deletePreset('main', 'daily').map((p) => p.name)).toEqual(['cull'])
  })

  it('survives junk in stored presets', () => {
    store.set('sd-v4-sort-presets:main', '{nope')
    expect(loadPresets('main')).toEqual([])
    store.set('sd-v4-sort-presets:main', JSON.stringify([{ name: '' }, { name: 'ok', mode: 'teleport', folders: { q: 1 } }, 7]))
    expect(loadPresets('main')).toEqual([{ name: 'ok', mode: 'slot', folders: {}, operation: 'move', rule: EMPTY_RULE, more: [], favorites: [] }])
  })
})
