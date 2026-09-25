import { describe, expect, it } from 'vitest'
import { adjustRaster, applyBaseOps, isNoAdjust, removeBackground } from './adjust'
import { applyDetectRun, regionsFromDetections } from './detection'
import {
  appendBase,
  appendManual,
  isBase,
  isDetection,
  NO_ADJUST,
  parseOps,
  type AdjustOp,
  type BackgroundOp,
  type Op,
  type StrokeOp,
} from './ops'
import { colorStats, histogramPeak } from './histogram'
import { downscale, memoryEstimateGb } from './largePicture'
import { newBaseCache, renderInto, renderOps } from './paint'
import { createRaster, type Raster } from './raster'

const W = 40
const H = 30

/** Every pixel a different colour: r = x * 6, g = y * 8, b = 100, opaque. */
function gradient(): Raster {
  const r = createRaster(W, H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) r.data.set([x * 6, y * 8, 100, 255], (y * W + x) * 4)
  return r
}

const px = (r: Raster, x: number, y: number) => Array.from(r.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4))

const stroke = (over: Partial<StrokeOp>): StrokeOp => ({
  type: 'stroke',
  id: over.id ?? 's',
  tool: 'brush',
  style: 'black',
  size: 4,
  block: 4,
  color: '#000000',
  opacity: 100,
  points: [10, 10],
  ...over,
})

const adjust = (values: Partial<AdjustOp['values']>, id = 'a'): AdjustOp => ({ type: 'adjust', id, values: { ...NO_ADJUST, ...values } })

/** Foreground: the rectangle x 10-19, y 5-14 as a run-length mask over the whole picture. */
function foreground(fill: BackgroundOp['fill']): BackgroundOp {
  const runs: number[] = []
  let set = false
  let run = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= 10 && x < 20 && y >= 5 && y < 15
      if (inside === set) run++
      else {
        runs.push(run)
        set = !set
        run = 1
      }
    }
  }
  runs.push(run)
  return { type: 'background', id: 'bg', fill, mask: { x: 0, y: 0, w: W, h: H, runs } }
}

describe('clone stamp', () => {
  it('copies the base picture from the offset, inside the brush only; sources outside the picture leave pixels as they are', () => {
    const original = gradient()
    const clone = stroke({ tool: 'clone', size: 4, points: [10, 10], offset: [15, 5] })
    const out = renderOps(original, [clone])
    // (10, 10) now shows what was at (25, 15)
    expect(px(out, 10, 10)).toEqual(px(original, 25, 15))
    expect(px(out, 9, 9)).toEqual(px(original, 24, 14))
    // outside the brush: unchanged
    expect(px(out, 20, 20)).toEqual(px(original, 20, 20))
    const offEdge = renderOps(original, [stroke({ tool: 'clone', points: [38, 10], offset: [10, 0] })])
    expect(px(offEdge, 38, 10)).toEqual(px(original, 38, 10))
  })

  it('copies the picture as shown, censoring included: cloning a black bar extends it, never un-censors', () => {
    const original = gradient()
    const bar = stroke({ id: 'bar', style: 'black', size: 12, points: [25, 15] })
    const clone = stroke({ id: 'c', tool: 'clone', size: 4, points: [10, 10], offset: [15, 5] })
    const out = renderOps(original, [bar, clone])
    expect(px(out, 25, 15)).toEqual([0, 0, 0, 255])
    expect(px(out, 10, 10)).toEqual([0, 0, 0, 255])
    expect(px(out, 9, 9)).toEqual([0, 0, 0, 255])
  })

  it('copies the censoring of a detection region too, and never its own output; replay gives the same bytes', () => {
    const original = gradient()
    const opts = { detector: 'nudenet', style: 'white' as const, block: 8, maskShape: 'box' as const, confidence: 0, width: W, height: H }
    const regions = regionsFromDetections([{ box: [20, 10, 30, 20], class: 'breasts', confidence: 0.9 }], opts, null)
    // clone from inside the white region (25, 15) to a clean spot (5, 25)
    const clone = stroke({ id: 'c', tool: 'clone', size: 4, points: [5, 25], offset: [20, -10] })
    const ops = appendManual(applyDetectRun([], regions), clone)
    const out = renderOps(original, ops)
    expect(px(out, 5, 25)).toEqual([255, 255, 255, 255])
    // overlapping source and destination: each pixel comes from the picture before this stroke
    const overlap = stroke({ id: 'o', tool: 'clone', size: 6, points: [10, 10, 14, 10], offset: [2, 0] })
    const shifted = renderOps(original, [overlap])
    expect(px(shifted, 11, 10)).toEqual(px(original, 13, 10))
    expect(Array.from(renderOps(original, ops).data)).toEqual(Array.from(out.data))
  })

  it('a clone stroke without a source is dropped when read back', () => {
    const ops = parseOps({ censor: { ops: [{ ...stroke({ tool: 'clone' }) }, stroke({ tool: 'clone', offset: [3.4, -2.6] })] } })
    expect(ops).toHaveLength(1)
    expect((ops[0] as StrokeOp).offset).toEqual([3, -3])
  })
})

describe('adjust filters', () => {
  it('zero changes nothing; each filter changes the picture in its own way', () => {
    const original = gradient()
    expect(Array.from(adjustRaster(original, NO_ADJUST).data)).toEqual(Array.from(original.data))
    expect(isNoAdjust(NO_ADJUST)).toBe(true)
    expect(isNoAdjust({ ...NO_ADJUST, hue: 360 })).toBe(true)
    expect(isNoAdjust({ ...NO_ADJUST, blur: 1 })).toBe(false)

    const brighter = adjustRaster(original, { ...NO_ADJUST, brightness: 50 })
    expect(px(brighter, 10, 10)).toEqual([90, 120, 150, 255])
    const gray = adjustRaster(original, { ...NO_ADJUST, saturation: -100 })
    const [r, g, b] = px(gray, 10, 10)
    expect(r).toBe(g)
    expect(g).toBe(b)
    const warm = adjustRaster(original, { ...NO_ADJUST, temperature: 20 })
    expect(px(warm, 10, 10)).toEqual([80, 80, 80, 255])
    const vignette = adjustRaster(original, { ...NO_ADJUST, vignette: 100 })
    // the centre barely changes, a corner gets much darker
    expect(Math.abs((px(vignette, 20, 15)[1] as number) - (px(original, 20, 15)[1] as number))).toBeLessThanOrEqual(1)
    expect(px(vignette, 39, 29)[0] as number).toBeLessThan((px(original, 39, 29)[0] as number) * 0.4)
    // alpha is never touched
    for (const out of [brighter, gray, warm, vignette, adjustRaster(original, { ...NO_ADJUST, blur: 3, sharpen: 50, hue: 90 })]) {
      expect(out.data.filter((_, i) => i % 4 === 3).every((a) => a === 255)).toBe(true)
    }
  })

  it('the same values give the same bytes every time (preview = replay = saved copy)', () => {
    const v = { ...NO_ADJUST, brightness: 10, contrast: 20, saturation: 30, hue: 45, blur: 2, sharpen: 40, temperature: -10, vignette: 30 }
    expect(Array.from(adjustRaster(gradient(), v).data)).toEqual(Array.from(adjustRaster(gradient(), v).data))
  })
})

describe('big pictures', () => {
  it('the small copy for the fast preview keeps the shape and samples the picture', () => {
    const original = gradient()
    const small = downscale(original, 300)
    expect(small.width * small.height).toBeLessThanOrEqual(320)
    expect(small.width / small.height).toBeCloseTo(W / H, 1)
    // each small pixel is the picture's pixel at the centre of its block
    const sx = Math.floor((0.5 * W) / small.width)
    const sy = Math.floor((0.5 * H) / small.height)
    expect(px(small, 0, 0)).toEqual(px(original, sx, sy))
    // never larger than the picture
    expect(downscale(original, 10_000)).toMatchObject({ width: W, height: H })
    expect(memoryEstimateGb(45_000_000)).toBe(2)
  })

  it('what is applied (and saved) is the full-size render the settled preview shows, byte for byte', () => {
    const original = gradient()
    const values = { ...NO_ADJUST, brightness: 30, vignette: 40 }
    const strokes: Op[] = [stroke({ id: 's', style: 'white', points: [5, 5, 30, 20] })]
    const settledPreview = renderOps(original, appendBase(strokes, { type: 'adjust', id: 'preview', values }))
    const applied = renderOps(original, appendBase(strokes, { type: 'adjust', id: 'a1', values: { ...values } }))
    expect(Array.from(applied.data)).toEqual(Array.from(settledPreview.data))
    // and it is not the small copy's pixels scaled up: the saved copy has the picture's own size
    expect(applied.width).toBe(W)
  })
})

describe('histogram and main colours', () => {
  it('counts each channel and lists the most common colour groups with their share', () => {
    const r = createRaster(10, 10)
    for (let i = 0; i < 100; i++) r.data.set(i < 70 ? [250, 10, 10, 255] : [10, 10, 250, 255], i * 4)
    const stats = colorStats(r)
    expect(stats.r[250]).toBe(70)
    expect(stats.b[250]).toBe(30)
    expect(stats.colors).toEqual([
      { hex: '#fa0a0a', share: 0.7 },
      { hex: '#0a0afa', share: 0.3 },
    ])
    expect(histogramPeak(stats)).toBe(100)
  })
})

describe('background removal', () => {
  it('everything outside the foreground becomes the fill; the foreground keeps its pixels', () => {
    const original = gradient()
    const clear = removeBackground(original, foreground('transparent'))
    expect(px(clear, 0, 0)).toEqual([0, 0, 0, 0])
    expect(px(clear, 12, 8)).toEqual(px(original, 12, 8))
    expect(px(removeBackground(original, foreground('white')), 30, 25)).toEqual([255, 255, 255, 255])
    expect(px(removeBackground(original, foreground('black')), 30, 25)).toEqual([0, 0, 0, 255])
  })

  it('the eraser restores the base picture (background still removed), not the file', () => {
    const original = gradient()
    const bar = stroke({ id: 'bar', style: 'black', size: 10, points: [30, 20] })
    const eraser = stroke({ id: 'e', tool: 'eraser', size: 10, points: [30, 20] })
    const out = renderOps(original, [foreground('white'), bar, eraser])
    expect(px(out, 30, 20)).toEqual([255, 255, 255, 255])
  })
})

describe('the three groups: picture edits, detections, strokes', () => {
  const opts = { detector: 'nudenet', style: 'black' as const, block: 8, maskShape: 'box' as const, confidence: 0, width: W, height: H }
  const regions = regionsFromDetections([{ box: [2, 2, 8, 8], class: 'breasts', confidence: 0.9 }], opts, null)

  it('picture edits stay first, detections next, strokes last, whatever order they were made in', () => {
    let ops: Op[] = []
    ops = appendManual(ops, stroke({ id: 'm1' }))
    ops = applyDetectRun(ops, regions)
    ops = appendBase(ops, adjust({ brightness: 10 }, 'a1'))
    ops = appendManual(ops, stroke({ id: 'm2' }))
    ops = appendBase(ops, foreground('white'))
    ops = applyDetectRun(ops, regionsFromDetections([{ box: [3, 3, 9, 9], class: 'anus', confidence: 0.5 }], opts, null))
    const kinds = ops.map((op) => (isBase(op) ? `base:${op.id}` : isDetection(op) ? 'detection' : `stroke:${op.id}`))
    expect(kinds).toEqual(['base:a1', 'base:bg', 'detection', 'stroke:m1', 'stroke:m2'])
    // reading back puts a scrambled list in the same order
    expect(parseOps({ censor: { ops: [...ops].reverse() } }).map((op) => op.type)).toEqual(['background', 'adjust', 'region', 'stroke', 'stroke'])
  })

  it('a filter never lightens a black bar: censoring is painted over the filtered picture', () => {
    const original = gradient()
    const out = renderOps(original, [adjust({ brightness: 100 }), stroke({ id: 'bar', style: 'black', size: 10, points: [20, 15] })])
    expect(px(out, 20, 15)).toEqual([0, 0, 0, 255])
    expect(px(out, 2, 2)).toEqual(px(adjustRaster(original, { ...NO_ADJUST, brightness: 100 }), 2, 2))
  })

  it('the base picture is made once while the picture edits stay the same', () => {
    const original = gradient()
    const target = createRaster(W, H)
    const cache = newBaseCache()
    const edits = [adjust({ blur: 2 })]
    const first = renderInto(target, original, [...edits, stroke({ id: 'x' })], undefined, cache)
    const again = renderInto(target, original, [...edits, stroke({ id: 'x' }), stroke({ id: 'y', points: [30, 20] })], undefined, cache)
    expect(again).toBe(first)
    const changed = renderInto(target, original, [adjust({ blur: 3 })], undefined, cache)
    expect(changed).not.toBe(first)
    expect(applyBaseOps(original, [])).toBe(original)
  })
})
