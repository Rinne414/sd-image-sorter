import { describe, expect, test } from 'vitest'
import { clampPan, FIT, fittedSize, isFit, limitsFor, percentOfOriginal, toggleZoom, wheelFactor, zoomAt, type Frame } from './zoom'

// A 4000 x 2000 picture in a 1000 x 800 stage: it fits at 1000 x 500, so its
// own pixels are 4x the fitted size.
const frame: Frame = { stage: { w: 1000, h: 800 }, fitted: fittedSize({ w: 4000, h: 2000 }, { w: 1000, h: 800 }), original: 4 }

describe('lightbox zoom', () => {
  test('fitting keeps the aspect ratio inside the box', () => {
    expect(fittedSize({ w: 4000, h: 2000 }, { w: 1000, h: 800 })).toEqual({ w: 1000, h: 500 })
    expect(fittedSize({ w: 500, h: 1000 }, { w: 1000, h: 800 })).toEqual({ w: 400, h: 800 })
  })

  test('the wheel zooms in and out around the pointer: the point under it stays put', () => {
    const at = { x: 200, y: 100 }
    const view = zoomAt(FIT, 2, at, frame)
    expect(view.scale).toBe(2)
    // the picture point under the pointer was 200 px right of centre at 1x; at 2x it would be 400, so the picture moves 200 back
    expect(view).toEqual({ scale: 2, x: -200, y: -100 })
    // and zooming back out returns to the fitted view
    expect(zoomAt(view, 0.5, at, frame)).toEqual(FIT)
  })

  test('beyond the original size, up to 8x its pixels; never smaller than fitted', () => {
    const max = zoomAt(FIT, 1000, { x: 0, y: 0 }, frame)
    expect(max.scale).toBe(32) // 8 x 4
    expect(percentOfOriginal(max, frame)).toBe(800)
    expect(zoomAt(FIT, 0.1, { x: 0, y: 0 }, frame)).toEqual(FIT)
  })

  test('a small picture (shown larger than its pixels when fitted) can go down to its own size', () => {
    const small: Frame = { stage: { w: 1000, h: 800 }, fitted: { w: 1000, h: 500 }, original: 0.25 }
    expect(limitsFor(small)).toEqual({ min: 0.25, max: 4 })
    expect(zoomAt(FIT, 0.1, { x: 0, y: 0 }, small).scale).toBe(0.25)
  })

  test('panning stops at the picture edges; a picture smaller than the stage stays centred', () => {
    // 2x: 2000 x 1000 in a 1000 x 800 stage, so it can move 500 px sideways and 100 px up or down
    expect(clampPan({ scale: 2, x: 900, y: -900 }, frame)).toEqual({ scale: 2, x: 500, y: -100 })
    expect(clampPan({ scale: 1.2, x: 50, y: 50 }, frame)).toEqual({ scale: 1.2, x: 50, y: 0 })
  })

  test('click or Z: fitted goes to the original size at the pointer, anything else goes back to fitted', () => {
    const actual = toggleZoom(FIT, { x: 0, y: 0 }, frame)
    expect(actual.scale).toBe(4)
    expect(percentOfOriginal(actual, frame)).toBe(100)
    expect(isFit(toggleZoom(actual, { x: 0, y: 0 }, frame))).toBe(true)
  })

  test('wheel steps: down zooms out, up zooms in, lines and pages count as more pixels', () => {
    expect(wheelFactor(100, 0)).toBeLessThan(1)
    expect(wheelFactor(-100, 0)).toBeGreaterThan(1)
    expect(wheelFactor(-3, 1)).toBeCloseTo(wheelFactor(-48, 0))
  })

  test('fitted reads as the share of the original size it shows', () => {
    expect(percentOfOriginal(FIT, frame)).toBe(25)
  })
})
