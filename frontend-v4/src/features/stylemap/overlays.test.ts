import { describe, expect, it } from 'vitest'
import { arrowFor, axisAnchors, cardBoxes, cardSizeFor, endTags, overlaps, placeCards, placeLabel, summaryParts, type Projected } from './overlays'

const at = (x: number, y: number, depth = 0, behind = false): Projected => ({ x, y, depth, behind })
const CANVAS = { width: 1000, height: 800 }

describe('landmark cards', () => {
  it('uses small cards on a short canvas (a 1366x768 window)', () => {
    expect(cardSizeFor(900, 570)).toBe('small')
    expect(cardSizeFor(1400, 880)).toBe('large')
  })

  it('hides a card whose centre is behind the camera or off the canvas', () => {
    const places = placeCards([at(100, 100, 0, true), at(-50, 100), at(300, 300)], CANVAS, 'large', -1, null)
    expect(places.map((p) => p.hidden)).toEqual([true, true, false])
  })

  it('turns a card that would sit on an earlier one into its picture only, never on top', () => {
    const places = placeCards([at(500, 400), at(510, 405), at(505, 402)], CANVAS, 'large', -1, null)
    const shown = places.filter((p) => !p.hidden)
    expect(places[0]).toMatchObject({ hidden: false, compact: false })
    expect(places[1]!.hidden || places[1]!.compact).toBe(true)
    const { full, compact } = cardBoxes('large')
    const rects = shown.map((p) => ({ x: p.x, y: p.y, w: (p.compact ? compact.w : full.w) * p.scale, h: (p.compact ? compact.h : full.h) * p.scale }))
    for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) expect(overlaps(rects[i]!, rects[j]!)).toBe(false)
  })

  it('shrinks and fades far cards; the open card stays full and inside the canvas', () => {
    const [far] = placeCards([at(300, 300, 1)], CANVAS, 'large', -1, null)
    expect(far!.scale).toBeCloseTo(0.72)
    expect(far!.opacity).toBeCloseTo(0.55)
    const [open] = placeCards([at(995, 795, 1)], CANVAS, 'large', 0, { w: 220, h: 200 })
    expect(open).toMatchObject({ scale: 1, opacity: 1, x: 780, y: 600 })
  })

  it('names a region by its tags, else its top artist', () => {
    expect(summaryParts({ tags: [{ tag: 'monochrome' }], artists: [{ artist: 'a', count: 1, high_total: 1 }] })).toEqual({ tags: ['monochrome'], artist: null })
    expect(summaryParts({ tags: [], artists: [{ artist: 'a', count: 1, high_total: 1 }] })).toEqual({ tags: [], artist: 'a' })
    expect(summaryParts({})).toEqual({ tags: [], artist: null })
  })
})

describe('axis labels', () => {
  it('anchors the ends on the floor grid, the vertical axis on its near-left corner', () => {
    const anchors = axisAnchors({ min: [-1, -1, -1], max: [1, 1, 1] }, -1.05, 1, 0.03)!
    expect(anchors.ends.x.low).toEqual([-1.03, -1.05, 0])
    expect(anchors.ends.y.high).toEqual([-1.03, 1, -1.03])
    expect(anchors.center[1]).toBeCloseTo(-0.025)
    expect(axisAnchors(null, -1, 1, 0.03)).toBeNull()
  })

  it('points an arrow the way the end lies on screen', () => {
    expect(arrowFor(1, 0)).toBe('→')
    expect(arrowFor(0, -1)).toBe('↑')
    expect(arrowFor(-1, 1)).toBe('↙')
  })

  it('names an end by its two strongest tags, or nothing', () => {
    expect(endTags({ tags: [{ tag: 'a' }, { tag: 'b' }, { tag: 'c' }] })).toEqual(['a', 'b'])
    expect(endTags({ tags: [] })).toBeNull()
    expect(endTags(undefined)).toBeNull()
  })

  it('puts a label outside the grid, inside the canvas, and clear of the labels before it', () => {
    const first = placeLabel({ x: 700, y: 400 }, { x: 500, y: 400 }, { w: 120, h: 20 }, CANVAS, [])
    expect(first.x).toBeGreaterThan(700)
    expect(first.x + first.w).toBeLessThanOrEqual(CANVAS.width)
    const second = placeLabel({ x: 700, y: 400 }, { x: 500, y: 400 }, { w: 120, h: 20 }, CANVAS, [first])
    expect(overlaps(first, second)).toBe(false)
  })
})
