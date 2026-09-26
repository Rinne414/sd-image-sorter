import { describe, expect, test } from 'vitest'
import { autoRefreshDue, EVERY_MS, IDLE_MS, readAutoRefresh, type IdleState } from './autoRefresh'

const MIN = 60_000

/** An hour into the session, the user idle for ten minutes, the last check twenty minutes ago. */
const idle = (fields: Partial<IdleState> = {}): IdleState => ({
  on: true,
  hidden: false,
  busy: false,
  now: 60 * MIN,
  lastActivity: 50 * MIN,
  lastAttempt: 40 * MIN,
  ...fields,
})

describe('autoRefreshDue', () => {
  test('waits for one idle minute and at most one check every five minutes', () => {
    expect(IDLE_MS).toBe(MIN)
    expect(EVERY_MS).toBe(5 * MIN)
    expect(autoRefreshDue(idle())).toBe(true)
    // exactly on both thresholds is due
    expect(autoRefreshDue(idle({ lastActivity: 59 * MIN, lastAttempt: 55 * MIN }))).toBe(true)
    // the user did something 59 s ago
    expect(autoRefreshDue(idle({ lastActivity: 60 * MIN - 59_000 }))).toBe(false)
    // the last check was 4 min 59 s ago
    expect(autoRefreshDue(idle({ lastAttempt: 55 * MIN + 1000 }))).toBe(false)
  })

  test('never while switched off, while the page is hidden, or while an import runs', () => {
    expect(autoRefreshDue(idle({ on: false }))).toBe(false)
    expect(autoRefreshDue(idle({ hidden: true }))).toBe(false)
    expect(autoRefreshDue(idle({ busy: true }))).toBe(false)
  })
})

describe('readAutoRefresh', () => {
  test('a started scan carries its run, source and folder', () => {
    const raw = { status: 'started', root: 'D:/art', scan: { status: 'started', run_id: 7, source: 'library_auto_refresh', message: '' } }
    expect(readAutoRefresh(raw)).toEqual({ kind: 'started', runId: 7, source: 'library_auto_refresh', root: 'D:/art' })
  })

  test('another import running, an unconfirmed import or no sources is skipped quietly', () => {
    expect(readAutoRefresh({ status: 'skipped', reason: 'scan_in_progress' })).toEqual({ kind: 'quiet' })
    expect(readAutoRefresh({ status: 'skipped', reason: 'manual_completion_pending' })).toEqual({ kind: 'quiet' })
    expect(readAutoRefresh({ status: 'idle', reason: 'no_enabled_roots' })).toEqual({ kind: 'quiet' })
  })

  test('anything else is reported with what the backend said', () => {
    expect(readAutoRefresh({ status: 'skipped', reason: 'scan_start_failed', detail: 'Folder not found' })).toEqual({
      kind: 'unexpected',
      detail: 'Folder not found',
    })
    expect(readAutoRefresh({ status: 'started', root: 'D:/art', scan: {} })).toEqual({ kind: 'unexpected', detail: 'started' })
    expect(readAutoRefresh(null)).toEqual({ kind: 'unexpected', detail: '' })
  })
})
