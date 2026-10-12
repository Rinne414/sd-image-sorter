import { describe, expect, it } from 'vitest'
import {
  applyDetectRun,
  applyRefined,
  applyTextRun,
  bitmapFromRgba,
  detectionsOf,
  erasedRegions,
  maskInBox,
  refinable,
  regionsFromDetections,
  setRegionOff,
  textDetector,
  toggleAllRegions,
  type MaskBitmap,
  type RegionOptions,
} from './detection'
import { appendManual, isDetection, parseOps, type Op, type RegionOp, type StrokeOp } from './ops'
import { renderOps } from './paint'
import { createRaster, visitMask } from './raster'

const OPTS: RegionOptions = { detector: 'nudenet', style: 'mosaic', block: 8, maskShape: 'precise', confidence: 0.5, width: 100, height: 80 }

/** A 100 x 80 mask with two filled rectangles (what a combined mask of two regions looks like). */
function twoBlobs(): MaskBitmap {
  const w = 100
  const h = 80
  const bits = new Uint8Array(w * h)
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) bits[y * w + x] = 1
  }
  fill(12, 10, 20, 18)
  fill(60, 40, 70, 44)
  return { x: 0, y: 0, w, h, bits }
}

function maskPixels(shape: RegionOp['shape'], w = 100, h = 80): Set<number> {
  const set = new Set<number>()
  if (shape.type === 'mask') visitMask(w, h, shape, (i) => set.add(i))
  return set
}

const stroke = (id: string, x: number): StrokeOp => ({
  type: 'stroke',
  id,
  tool: 'brush',
  style: 'black',
  size: 6,
  block: 8,
  color: '#000000',
  opacity: 100,
  points: [x, 5, x + 10, 5],
})

describe('detect answers become region ops', () => {
  it('precise: the combined mask inside each box, most confident first, low scores and bad boxes left out', () => {
    const detections = [
      { box: [10, 8, 30, 20], class: 'breasts', confidence: 0.6 },
      { box: [55, 35, 75, 50], class: 'pussy', label: 'FEMALE_GENITALIA_EXPOSED', confidence: 0.9 },
      { box: [0, 0, 5, 5], class: 'anus', confidence: 0.2 },
      { box: [5, 5, 5, 9], class: 'cum', confidence: 0.99 },
      { class: 'no box', confidence: 0.99 },
    ]
    const regions = regionsFromDetections(detections, OPTS, twoBlobs())
    expect(regions.map((r) => [r.label, r.confidence])).toEqual([
      ['pussy', 0.9],
      ['breasts', 0.6],
    ])
    const [pussy, breasts] = regions as [RegionOp, RegionOp]
    expect(pussy).toMatchObject({ source: 'detection', detector: 'nudenet', style: 'mosaic', block: 8, box: [55, 35, 75, 50] })
    // trimmed to the set pixels: exactly the 10 x 4 blob, nothing of the other blob
    expect(pussy.shape).toMatchObject({ type: 'mask', x: 60, y: 40, w: 10, h: 4 })
    expect(maskPixels(pussy.shape).size).toBe(40)
    expect(maskPixels(breasts.shape).size).toBe(64)
  })

  it('a YOLO -seg polygon wins over the combined mask; no mask pixels in the box falls back to the box', () => {
    const polygon = [[40, 40], [50, 40], [45, 50]]
    const regions = regionsFromDetections(
      [
        { box: [40, 40, 50, 50], class: 'dick', confidence: 0.8, polygon },
        { box: [80, 60, 90, 70], class: 'anus', confidence: 0.7 },
      ],
      OPTS,
      twoBlobs(),
    )
    expect(regions[0]?.shape).toEqual({ type: 'polygon', points: [40, 40, 50, 40, 45, 50] })
    expect(regions[1]?.shape).toEqual({ type: 'polygon', points: [80, 60, 90, 60, 90, 70, 80, 70] })
  })

  it('box shape ignores masks and polygons; boxes are clipped to the image', () => {
    const regions = regionsFromDetections(
      [{ box: [90, 70, 130, 95], class: 'buttocks', confidence: 0.55, polygon: [[1, 1], [2, 2], [3, 1]] }],
      { ...OPTS, maskShape: 'box' },
      twoBlobs(),
    )
    expect(regions[0]?.shape).toEqual({ type: 'polygon', points: [90, 70, 100, 70, 100, 80, 90, 80] })
    expect(regions[0]?.box).toEqual([90, 70, 100, 80])
  })

  it('mask pixels come from alpha (inline masks) or grey (cached masks)', () => {
    // 2 x 1: pixel 0 white + opaque, pixel 1 white + transparent
    const inline = bitmapFromRgba([255, 255, 255, 255, 255, 255, 255, 0], 2, 1, 5, 6)
    expect([...inline.bits]).toEqual([1, 0])
    expect(inline).toMatchObject({ x: 5, y: 6, w: 2, h: 1 })
    const cached = bitmapFromRgba([0, 0, 0, 255, 200, 200, 200, 255], 2, 1, 0, 0)
    expect([...cached.bits]).toEqual([0, 1])
  })

  it('an empty mask in the box gives null; a mask shape paints exactly its pixels', () => {
    expect(maskInBox(twoBlobs(), [30, 30, 40, 40])).toBeNull()
    // a cropped mask (as the detector sends it) and a box wholly beside it, above it, or below it
    const cropped: MaskBitmap = { x: 50, y: 40, w: 4, h: 4, bits: new Uint8Array(16).fill(1) }
    expect(maskInBox(cropped, [5, 5, 30, 30])).toBeNull()
    expect(maskInBox(cropped, [60, 0, 90, 30])).toBeNull()
    expect(maskInBox(cropped, [50, 60, 54, 70])).toBeNull()
    expect(maskInBox(cropped, [52, 0, 90, 42])).toMatchObject({ type: 'mask', x: 52, y: 40, w: 2, h: 2 })
    const shape = maskInBox(twoBlobs(), [0, 0, 100, 80])
    expect(shape).toMatchObject({ type: 'mask', x: 12, y: 10 })
    const original = createRaster(100, 80)
    const region: RegionOp = { type: 'region', id: 'r', source: 'detection', detector: 'x', label: 'x', style: 'white', block: 8, shape: shape as RegionOp['shape'] }
    const out = renderOps(original, [region])
    let white = 0
    for (let i = 0; i < 100 * 80; i++) if (out.data[i * 4] === 255) white++
    expect(white).toBe(64 + 40)
  })
})

describe('detections never touch manual strokes', () => {
  const manualOf = (ops: readonly Op[]) => JSON.stringify(ops.filter((op) => !isDetection(op)))

  it('detect, re-detect, text segmentation, refine, toggles and reload keep every manual op byte-identical', () => {
    let ops: Op[] = []
    ops = appendManual(ops, stroke('m1', 10))
    ops = appendManual(ops, { ...stroke('m2', 40), tool: 'eraser' })
    const before = manualOf(ops)

    const first = regionsFromDetections([{ box: [10, 8, 30, 20], class: 'breasts', confidence: 0.9 }], OPTS, twoBlobs())
    ops = applyDetectRun(ops, first)
    const text = regionsFromDetections([{ box: [55, 35, 75, 50], class: 'x', confidence: 1 }], { ...OPTS, detector: textDetector('Tattoo') }, twoBlobs())
    ops = applyTextRun(ops, textDetector('tattoo'), text)
    const again = regionsFromDetections([{ box: [55, 35, 75, 50], class: 'pussy', confidence: 0.8 }], { ...OPTS, detector: 'both' }, twoBlobs())
    ops = applyDetectRun(ops, again)
    const target = refinable(ops)[0] as RegionOp
    ops = applyRefined(ops, new Map([[target.id, { type: 'polygon', points: [1, 1, 9, 1, 5, 9] }]]))
    ops = setRegionOff(ops, target.id, true)
    ops = toggleAllRegions(ops)
    ops = parseOps({ censor: { v: 1, width: 100, height: 80, ops } })

    expect(manualOf(ops)).toBe(before)
    // detections still form the prefix, manual ops the tail in their own order
    expect(ops.map((op) => op.type)).toEqual(['region', 'region', 'stroke', 'stroke'])
  })

  it('re-detect replaces every earlier detector region but keeps text regions; text replaces only its prompt', () => {
    const a = regionsFromDetections([{ box: [10, 8, 30, 20], class: 'breasts', confidence: 0.9 }], OPTS, null)
    const t1 = regionsFromDetections([{ box: [1, 1, 9, 9], class: 'face', confidence: 1 }], { ...OPTS, detector: textDetector('face') }, null)
    const t2 = regionsFromDetections([{ box: [1, 1, 9, 9], class: 'logo', confidence: 1 }], { ...OPTS, detector: textDetector('logo') }, null)
    let ops: Op[] = applyTextRun(applyTextRun(applyDetectRun([stroke('m', 1)], a), textDetector('face'), t1), textDetector('logo'), t2)
    const b = regionsFromDetections([{ box: [50, 30, 60, 40], class: 'anus', confidence: 0.7 }], { ...OPTS, detector: 'legacy' }, null)
    ops = applyDetectRun(ops, b)
    expect(detectionsOf(ops).map((r) => r.label)).toEqual(['face', 'logo', 'anus'])
    const t3 = regionsFromDetections([{ box: [2, 2, 8, 8], class: 'face', confidence: 1 }], { ...OPTS, detector: textDetector('face') }, null)
    ops = applyTextRun(ops, textDetector('face'), t3)
    expect(detectionsOf(ops).map((r) => r.label)).toEqual(['logo', 'anus', 'face'])
    expect(refinable(ops).map((r) => r.label)).toEqual(['anus'])
  })
})

describe('regions the eraser went over', () => {
  it('names each detection an eraser stroke overlaps, so review can say it was changed by hand', () => {
    const regions = regionsFromDetections(
      [
        { box: [10, 10, 30, 30], class: 'breasts', confidence: 0.9 },
        { box: [60, 40, 80, 60], class: 'pussy', confidence: 0.8 },
      ],
      { ...OPTS, maskShape: 'box' },
      null,
    )
    const [first, second] = regions as [RegionOp, RegionOp]
    const eraser = { ...stroke('e', 0), tool: 'eraser' as const, size: 6, points: [32, 20, 40, 20] }
    const brush = { ...stroke('b', 0), points: [70, 50] }
    const ops = applyDetectRun([eraser, brush], regions)
    // the eraser's edge (32 - 3) reaches into the first box; a brush stroke is not an erase
    expect([...erasedRegions(ops)]).toEqual([first.id])
    expect(erasedRegions(applyDetectRun([brush], regions)).size).toBe(0)
    expect(erasedRegions(ops).has(second.id)).toBe(false)
  })
})

describe('review toggles', () => {
  const regions = regionsFromDetections(
    [
      { box: [10, 8, 30, 20], class: 'breasts', confidence: 0.9 },
      { box: [55, 35, 75, 50], class: 'pussy', confidence: 0.8 },
    ],
    { ...OPTS, style: 'white' },
    twoBlobs(),
  )
  const base = applyDetectRun([stroke('m', 1)], regions)

  it('a region switched off keeps its place, is not painted, and comes back when switched on', () => {
    const id = (regions[0] as RegionOp).id
    const off = setRegionOff(base, id, true)
    expect(off).not.toBe(base)
    expect(detectionsOf(off).map((r) => [r.label, !!r.off])).toEqual([
      ['breasts', true],
      ['pussy', false],
    ])
    const img = createRaster(100, 80)
    const white = (ops: Op[]) => renderOps(img, ops).data.filter((_, i) => i % 4 === 0 && _ === 255).length
    expect(white(off)).toBe(40)
    expect(white(base)).toBe(104)
    const on = setRegionOff(off, id, false)
    expect(white(on)).toBe(104)
    expect(JSON.stringify(on)).toBe(JSON.stringify(base))
    // switching to the state it already has changes nothing
    expect(setRegionOff(base, id, false)).toEqual(base)
  })

  it('A switches every region off when any is on, then every region on', () => {
    const allOff = toggleAllRegions(base)
    expect(detectionsOf(allOff).every((r) => r.off)).toBe(true)
    const allOn = toggleAllRegions(allOff)
    expect(detectionsOf(allOn).every((r) => !r.off)).toBe(true)
    const oneOff = setRegionOff(base, (regions[1] as RegionOp).id, true)
    expect(detectionsOf(toggleAllRegions(oneOff)).every((r) => r.off)).toBe(true)
  })
})
