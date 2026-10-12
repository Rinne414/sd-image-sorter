import { describe, expect, test } from 'vitest'
import { canResetStuck, isStalled, nextStall, STALL_MS } from './stuck'

describe('a job stuck while stopping', () => {
  test('the clock starts when it begins stopping and only then', () => {
    expect(nextStall(null, 'running', 1000)).toBeNull()
    expect(nextStall(null, 'cancelling', 1000)).toBe(1000)
    expect(nextStall(1000, 'cancelling', 5000)).toBe(1000)
    // It moved on (or ended): the clock is dropped.
    expect(nextStall(1000, 'running', 6000)).toBeNull()
    expect(nextStall(1000, 'cancelled', 6000)).toBeNull()
  })

  test('the reset is offered only after the stall window, never earlier', () => {
    expect(isStalled(null, 99_999)).toBe(false)
    expect(isStalled(1000, 1000 + STALL_MS - 1)).toBe(false)
    expect(isStalled(1000, 1000 + STALL_MS)).toBe(true)
  })

  test('only the file queues and an import can be reset from the drawer', () => {
    expect(['move', 'copy', 'trash', 'remove', 'scan'].every((k) => canResetStuck(k as never))).toBe(true)
    expect(canResetStuck('tag')).toBe(false)
    expect(canResetStuck('reparse')).toBe(false)
  })
})
