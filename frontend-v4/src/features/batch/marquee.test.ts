import { describe, expect, it } from 'vitest'
import { boxOf, edgeScroll, gridRects, hitKeys, isDrag, marqueeSelection } from './marquee'
import { clickSelection, NO_PICKS } from './pickLogic'

// Box (marquee) selection in a batch's grids, as V3.5's queue had it: drag
// from empty space, every picture the box touches joins the selection, and
// what Ctrl/Shift clicks picked before stays picked.

const rect = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h })

describe('the box', () => {
  it('is the same whichever corner the drag starts from', () => {
    expect(boxOf({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ left: 10, top: 20, right: 50, bottom: 80 })
  })

  it('starts only after the pointer moved a few pixels (a click on empty space is not a box)', () => {
    expect(isDrag({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(false)
    expect(isDrag({ x: 0, y: 0 }, { x: 0, y: 6 })).toBe(true)
  })
})

describe('what the box touches', () => {
  const tiles = [
    { key: 'a', rect: rect(0, 0, 100, 100) },
    { key: 'b', rect: rect(110, 0, 100, 100) },
    { key: 'c', rect: rect(0, 110, 100, 100) },
  ]

  it('takes every tile the box overlaps, even by a corner, in grid order', () => {
    expect(hitKeys(tiles, boxOf({ x: 90, y: 90 }, { x: 120, y: 120 }))).toEqual(['a', 'b', 'c'])
    expect(hitKeys(tiles, boxOf({ x: 105, y: 5 }, { x: 108, y: 200 }))).toEqual([])
  })

  it('lays out the virtual pick grid the way the page draws it', () => {
    const laid = gridRects(['a', 'b', 'c'], { cols: 2, tileW: 100, rowH: 130, gap: 8, pad: 16 })
    expect(laid[0]).toEqual({ key: 'a', rect: rect(16, 16, 100, 122) })
    expect(laid[1]?.rect.left).toBe(124)
    expect(laid[2]).toEqual({ key: 'c', rect: rect(16, 146, 100, 122) })
  })
})

describe('merging with the selection', () => {
  const order = ['a', 'b', 'c', 'd']

  it('adds the boxed pictures to what was picked when the drag began', () => {
    const ctrlPicked = clickSelection(NO_PICKS, order, 3, { ctrl: true, shift: false })
    const next = marqueeSelection(ctrlPicked, ['a', 'b'])
    expect([...next.keys].sort()).toEqual(['a', 'b', 'd'])
    expect(next.anchor).toBe(3)
  })

  it('drops a picture again when the box shrinks off it, but never one picked before the drag', () => {
    const base = { keys: new Set(['b']), anchor: 1 }
    expect([...marqueeSelection(base, ['a', 'b']).keys].sort()).toEqual(['a', 'b'])
    expect([...marqueeSelection(base, []).keys]).toEqual(['b'])
  })

  it('leaves its input alone', () => {
    const base = { keys: new Set(['b']), anchor: 1 }
    marqueeSelection(base, ['a'])
    expect([...base.keys]).toEqual(['b'])
  })
})

describe('scrolling while boxing', () => {
  it('scrolls up near the top edge, down near the bottom, not in between', () => {
    expect(edgeScroll(105, 100, 600)).toBeLessThan(0)
    expect(edgeScroll(598, 100, 600)).toBeGreaterThan(0)
    expect(edgeScroll(350, 100, 600)).toBe(0)
  })

  it('scrolls faster the further past the edge the pointer is', () => {
    expect(edgeScroll(640, 100, 600)).toBeGreaterThan(edgeScroll(590, 100, 600))
  })
})
