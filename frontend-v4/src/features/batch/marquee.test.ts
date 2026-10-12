import { describe, expect, it } from 'vitest'
import { boxOf, contentAt, edgeScroll, gridRects, hitKeys, isDrag, marqueeSelection, onContent, tileRectIn } from './marquee'
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

// At the automatic 130 % interface zoom (2560 px screens) the pointer and element
// boxes are in screen px while the grid's content, scroll offsets and client size
// are in the page's own px: everything the box does is worked out in page px.
describe('the box under the interface zoom', () => {
  const grid = { left: 364, top: 248 }
  const client = { width: 1689, height: 917 }

  it('turns the pointer into a point of the scrolled content, in page px', () => {
    expect(contentAt(364 + 130, 248 + 260, grid, { left: 0, top: 100 }, 1.3)).toEqual({ x: 100, y: 300 })
    expect(contentAt(364 + 100, 248 + 200, grid, { left: 0, top: 100 }, 1)).toEqual({ x: 100, y: 300 })
  })

  it('reads a tile where the box reads the pointer', () => {
    const tile = { left: 364 + 13, top: 248 + 26, right: 364 + 13 + 260, bottom: 248 + 26 + 390 }
    expect(tileRectIn(tile, grid, { left: 0, top: 0 }, 1.3)).toEqual({ left: 10, top: 20, right: 210, bottom: 320 })
  })

  it('starts from anywhere on the background, the far corner too, but not on the scrollbar', () => {
    // the grid's bottom-right corner, 8 screen px in: inside its content (1683 x 911 page px)
    expect(onContent(364 + 2196 - 8, 248 + 1192 - 8, grid, client, 1.3)).toBe(true)
    // past the content width: the scrollbar
    expect(onContent(364 + (1689 + 4) * 1.3, 248 + 100, grid, client, 1.3)).toBe(false)
    expect(onContent(364 + 1689 - 8, 248 + 917 - 8, grid, client, 1)).toBe(true)
    expect(onContent(364 + 1689 + 4, 248 + 100, grid, client, 1)).toBe(false)
  })
})
