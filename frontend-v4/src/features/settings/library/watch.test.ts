import { describe, expect, it } from 'vitest'
import { ACTIVE_POLL_MS, IDLE_POLL_MS, isWatched, picturesArrived, pollDelay, readWatchStatus, watchLines, watchStateFor, type RootWatchState } from './watch'

const state = (over: Partial<RootWatchState> = {}): RootWatchState => ({
  root_id: 3,
  path: 'D:/ComfyUI/output',
  mode: 'native',
  state: 'watching',
  error: null,
  imported: 0,
  last_import_at: null,
  ...over,
})

describe('folder watching status', () => {
  it('reads the backend answer and drops junk roots', () => {
    const status = readWatchStatus({ running: true, paused: false, generation: 7, roots: [state(), { nope: 1 }, 5] })
    expect(status).toEqual({ paused: false, generation: 7, roots: [state()] })
    expect(readWatchStatus(null)).toBeNull()
    expect(readWatchStatus({ generation: 1 })).toBeNull()
  })

  it('the switch is stored as 0/1', () => {
    expect(isWatched({ watch: 1 })).toBe(true)
    expect(isWatched({ watch: 0 })).toBe(false)
    expect(isWatched({ watch: true })).toBe(true)
    expect(isWatched({})).toBe(false)
  })

  it('new pictures = the counter changed (also when the program restarted and it went back to 0)', () => {
    expect(picturesArrived(null, 4)).toBe(false)
    expect(picturesArrived(4, 4)).toBe(false)
    expect(picturesArrived(4, 5)).toBe(true)
    expect(picturesArrived(9, 0)).toBe(true)
  })

  it('polls quickly only while something is watched', () => {
    expect(pollDelay(null)).toBe(IDLE_POLL_MS)
    expect(pollDelay({ paused: false, generation: 0, roots: [] })).toBe(IDLE_POLL_MS)
    expect(pollDelay({ paused: false, generation: 0, roots: [state()] })).toBe(ACTIVE_POLL_MS)
  })

  it('finds the state of one folder', () => {
    const status = { paused: false, generation: 0, roots: [state(), state({ root_id: 9 })] }
    expect(watchStateFor(status, 9)?.root_id).toBe(9)
    expect(watchStateFor(status, 1)).toBeUndefined()
    expect(watchStateFor(null, 3)).toBeUndefined()
  })
})

describe('the line a watched folder shows', () => {
  it('says what it is doing', () => {
    expect(watchLines(undefined, false)).toEqual([{ key: 'libset.watch.starting' }])
    expect(watchLines(state({ state: 'catching_up' }), false)).toEqual([{ key: 'libset.watch.catchingUp' }])
    expect(watchLines(state({ state: 'missing' }), false)).toEqual([{ key: 'libset.watch.missing' }])
    expect(watchLines(state({ state: 'error', error: 'Access denied' }), false)).toEqual([{ key: 'libset.watch.error', params: { error: 'Access denied' } }])
    expect(watchLines(state(), false)).toEqual([{ key: 'libset.watch.active' }])
    expect(watchLines(state({ mode: 'polling' }), false)).toEqual([{ key: 'libset.watch.polling' }])
  })

  it('a pause from the tray wins over everything', () => {
    expect(watchLines(state({ imported: 5 }), true)).toEqual([{ key: 'libset.watch.paused' }])
  })

  it('adds how many pictures came in and when', () => {
    expect(watchLines(state({ imported: 12, last_import_at: '2026-10-23T21:14:05' }), false)).toEqual([
      { key: 'libset.watch.active' },
      { key: 'libset.watch.imported', params: { n: 12, when: '2026-10-23 21:14:05' } },
    ])
  })
})
