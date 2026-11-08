import { describe, expect, it } from 'vitest'
import { createFlickGate } from './flickGate'

function harness() {
  let clock = 0
  let top = 0
  let nextId = 1
  const timers = new Map<number, { fn: () => void, at: number }>()
  const changes: boolean[] = []
  const gate = createFlickGate({
    getScrollTop: () => top,
    onChange: (flinging) => changes.push(flinging),
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id },
    clearTimer: (id) => { timers.delete(id as number) },
  })
  return {
    gate,
    changes,
    step(ms: number, px: number) { clock += ms; top += px; gate.noteScroll() },
    wait(ms: number, movedPx = 0) {
      clock += ms
      top += movedPx
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) { timers.delete(id); timer.fn() }
      }
    },
  }
}

describe('createFlickGate', () => {
  it('leaves reading-pace scrolling alone', () => {
    const h = harness()
    h.step(0, 0)
    h.step(100, 100)
    h.step(100, 100)
    expect(h.gate.isFlinging()).toBe(false)
    expect(h.changes).toEqual([])
  })

  it('holds a flick until the gallery really stops', () => {
    const h = harness()
    h.step(0, 0)
    h.step(16, 600)
    expect(h.gate.isFlinging()).toBe(true)
    // The timer fires while the page moved on and its scroll event is still queued.
    h.wait(120, 300)
    expect(h.gate.isFlinging()).toBe(true)
    h.step(20, 0)
    h.wait(120)
    expect(h.gate.isFlinging()).toBe(false)
    expect(h.changes).toEqual([true, false])
  })

  it('lets a fling that slowed to a reading pace show its tiles while still moving', () => {
    const h = harness()
    h.step(0, 0)
    h.step(16, 600)
    for (let i = 0; i < 12; i += 1) h.step(16, 16)
    expect(h.gate.isFlinging()).toBe(false)
    expect(h.changes).toEqual([true, false])
  })

  it('treats a jump after a pause as slow', () => {
    const h = harness()
    h.step(0, 0)
    h.step(2000, 50000)
    expect(h.gate.isFlinging()).toBe(false)
  })
})
