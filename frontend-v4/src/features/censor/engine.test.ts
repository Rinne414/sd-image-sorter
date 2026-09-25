import { describe, expect, it } from 'vitest'
import { EMPTY_HISTORY, record, redo, undo } from './history'
import {
  appendManual,
  farEnough,
  insertDetections,
  parseOps,
  redetect,
  replaceDetections,
  withCensorState,
  type Op,
  type RegionOp,
  type StrokeOp,
} from './ops'
import { applyOp, createPainter, renderOps } from './paint'
import { createRaster, visitMask, visitPolygon, type Raster } from './raster'

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function makeRaster(w: number, h: number, fill: (x: number, y: number) => [number, number, number]): Raster {
  const r = createRaster(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [a, b, c] = fill(x, y)
      r.data.set([a, b, c, 255], (y * w + x) * 4)
    }
  }
  return r
}

const noise = (w: number, h: number, seed = 7) => {
  const rand = lcg(seed)
  return makeRaster(w, h, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)])
}

const px = (r: Raster, x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4))

function stroke(over: Partial<StrokeOp> & { points: number[] }): StrokeOp {
  return { type: 'stroke', id: 's', tool: 'brush', style: 'mosaic', size: 10, block: 4, color: '#000000', opacity: 100, ...over }
}

function region(id: string, detector: string, points: number[], over: Partial<RegionOp> = {}): RegionOp {
  return { type: 'region', id, source: 'detection', detector, label: 'x', style: 'black', block: 4, shape: { type: 'polygon', points }, ...over }
}

describe('mosaic', () => {
  it('turns every touched cell into its average and leaves other cells alone', () => {
    const img = makeRaster(12, 12, (x, y) => [x * 20, y * 20, 100])
    const out = renderOps(img, [stroke({ points: [2, 2], size: 2, block: 4 })])
    // cell (0,0): x 0..3, y 0..3 -> averages 30 and 30
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(px(out, x, y)).toEqual([30, 30, 100, 255])
    expect(px(out, 4, 0)).toEqual(px(img, 4, 0))
    expect(px(out, 0, 4)).toEqual(px(img, 0, 4))
  })

  it('averages a cell cut by the image edge over the pixels that exist', () => {
    const img = makeRaster(10, 10, (x) => [x * 10, 0, 0])
    const out = renderOps(img, [stroke({ points: [9, 9], size: 2, block: 4 })])
    // cell (2,2) covers x 8..9 only -> (80 + 90) / 2 = 85
    expect(px(out, 8, 8)).toEqual([85, 0, 0, 255])
    expect(px(out, 9, 9)).toEqual([85, 0, 0, 255])
    expect(px(out, 7, 9)).toEqual(px(img, 7, 9))
  })
})

describe('blur', () => {
  it('keeps every blurred value within the range of its neighbourhood and changes only the stroke', () => {
    const img = noise(40, 40)
    const op = stroke({ style: 'blur', block: 4, size: 10, points: [20, 20] })
    const out = renderOps(img, [op])
    let changed = 0
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        const inside = (x + 0.5 - 20) ** 2 + (y + 0.5 - 20) ** 2 <= 25
        if (!inside) {
          expect(px(out, x, y)).toEqual(px(img, x, y))
          continue
        }
        for (let c = 0; c < 3; c++) {
          let lo = 255
          let hi = 0
          for (let yy = Math.max(0, y - 12); yy <= Math.min(39, y + 12); yy++) {
            for (let xx = Math.max(0, x - 12); xx <= Math.min(39, x + 12); xx++) {
              lo = Math.min(lo, px(img, xx, yy)[c] as number)
              hi = Math.max(hi, px(img, xx, yy)[c] as number)
            }
          }
          const v = px(out, x, y)[c] as number
          expect(v).toBeGreaterThanOrEqual(lo)
          expect(v).toBeLessThanOrEqual(hi)
        }
        if (px(out, x, y).join() !== px(img, x, y).join()) changed++
      }
    }
    expect(changed).toBeGreaterThan(50)
  })

  it('leaves a flat colour flat', () => {
    const img = makeRaster(20, 20, () => [90, 120, 30])
    const out = renderOps(img, [stroke({ style: 'blur', block: 8, size: 30, points: [10, 10] })])
    expect(Array.from(out.data)).toEqual(Array.from(img.data))
  })
})

describe('solid fill', () => {
  it('black and white brushes cover exactly the stroke', () => {
    const img = noise(16, 16)
    const out = renderOps(img, [stroke({ style: 'black', size: 4, points: [8, 8] }), stroke({ style: 'white', size: 2, points: [2, 2] })])
    expect(px(out, 8, 8)).toEqual([0, 0, 0, 255])
    expect(px(out, 7, 7)).toEqual([0, 0, 0, 255])
    expect(px(out, 2, 2)).toEqual([255, 255, 255, 255])
    expect(px(out, 12, 12)).toEqual(px(img, 12, 12))
  })

  it('the pen blends its colour once per stroke, even where the stroke crosses itself', () => {
    const img = makeRaster(20, 20, () => [255, 255, 255])
    const pen = stroke({ tool: 'pen', color: '#ff0000', opacity: 50, size: 6, points: [5, 10, 15, 10, 5, 10, 15, 10] })
    const out = renderOps(img, [pen])
    expect(px(out, 10, 10)).toEqual([255, 128, 128, 255])
    expect(px(out, 10, 2)).toEqual([255, 255, 255, 255])
  })
})

describe('eraser', () => {
  it('restores the exact original pixels under it', () => {
    const img = noise(30, 30)
    const ops: Op[] = [
      stroke({ style: 'mosaic', size: 20, points: [10, 10, 20, 20] }),
      stroke({ style: 'blur', block: 5, size: 16, points: [15, 5] }),
      stroke({ tool: 'pen', color: '#00ff00', opacity: 40, size: 12, points: [5, 25, 25, 5] }),
      stroke({ tool: 'eraser', size: 200, points: [15, 15] }),
    ]
    expect(Array.from(renderOps(img, ops).data)).toEqual(Array.from(img.data))
  })

  it('only restores where it went', () => {
    const img = noise(20, 20)
    const out = renderOps(img, [stroke({ style: 'black', size: 40, points: [10, 10] }), stroke({ tool: 'eraser', size: 4, points: [3, 3] })])
    expect(px(out, 3, 3)).toEqual(px(img, 3, 3))
    expect(px(out, 15, 15)).toEqual([0, 0, 0, 255])
  })
})

describe('image edges', () => {
  it('clips strokes that run off the image', () => {
    const img = noise(16, 16)
    const out = renderOps(img, [stroke({ style: 'black', size: 20, points: [-30, -30, 2, 2, 40, -5] })])
    expect(out.data.length).toBe(img.data.length)
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 255])
    expect(px(out, 15, 15)).toEqual(px(img, 15, 15))
  })

  it('changes nothing for a stroke entirely outside', () => {
    const img = noise(16, 16)
    const target = renderOps(img, [])
    expect(applyOp(target, img, stroke({ style: 'black', size: 10, points: [-50, -50, -20, -40] }))).toBeNull()
    expect(Array.from(target.data)).toEqual(Array.from(img.data))
  })
})

describe('replay', () => {
  const cases: Partial<StrokeOp>[] = [
    { style: 'mosaic', block: 6 },
    { style: 'blur', block: 4 },
    { style: 'black' },
    { style: 'white' },
    { tool: 'pen', color: '#3366cc', opacity: 35 },
    { tool: 'eraser' },
  ]

  it.each(cases)('live painting point by point gives the same bytes as replaying the op (%o)', (over) => {
    const img = noise(64, 48, 3)
    const before = renderOps(img, [stroke({ style: 'black', size: 30, points: [10, 10, 50, 30] })])
    const points = [4, 40, 20, 20, 22, 21, 40, 8, 60, 44, 30, 30]
    const op = stroke({ size: 14, points, ...over })

    const live = renderOps(before, [])
    const painter = createPainter(live, img, op)
    for (let k = 0; k < points.length; k += 2) painter.add(points.slice(k, k + 2))

    const replay = renderOps(before, [])
    applyOp(replay, img, op)
    expect(Array.from(live.data)).toEqual(Array.from(replay.data))
  })

  it('replays N random ops to the same bytes every time', () => {
    const rand = lcg(11)
    const styles = ['mosaic', 'blur', 'black', 'white'] as const
    const tools = ['brush', 'brush', 'pen', 'eraser'] as const
    const ops: Op[] = Array.from({ length: 25 }, (_, i) =>
      stroke({
        id: `s${i}`,
        tool: tools[Math.floor(rand() * 4)],
        style: styles[Math.floor(rand() * 4)],
        size: 5 + Math.floor(rand() * 30),
        block: 4 + Math.floor(rand() * 10),
        opacity: 10 + Math.floor(rand() * 90),
        color: '#a0b0c0',
        points: Array.from({ length: 8 }, () => rand() * 80 - 5),
      }),
    )
    const img = noise(70, 60, 5)
    const a = renderOps(img, ops)
    const b = renderOps(img, ops)
    expect(Array.from(a.data)).toEqual(Array.from(b.data))
    expect(Array.from(a.data)).not.toEqual(Array.from(img.data))
  })
})

describe('detection ops', () => {
  const s1 = stroke({ id: 's1', style: 'black', points: [1, 1] })
  const s2 = stroke({ id: 's2', tool: 'eraser', points: [5, 5] })

  it('insertion puts regions before the manual strokes and keeps those strokes as they were', () => {
    const d1 = region('d1', 'yolo', [0, 0, 4, 0, 4, 4])
    const ops = insertDetections(appendManual(appendManual([], s1), s2), [d1])
    expect(ops.map((o) => o.id)).toEqual(['d1', 's1', 's2'])
    expect(ops[1]).toBe(s1)
    expect(ops[2]).toBe(s2)
    const more = insertDetections(ops, [region('d2', 'sam', [0, 0, 2, 0, 2, 2])])
    expect(more.map((o) => o.id)).toEqual(['d1', 'd2', 's1', 's2'])
  })

  it('re-detecting replaces only the earlier detections of that detector', () => {
    const ops: Op[] = [region('d1', 'yolo', [0, 0, 4, 0, 4, 4]), region('d2', 'sam', [0, 0, 2, 0, 2, 2]), s1, s2]
    const next = redetect(ops, 'yolo', [region('d3', 'yolo', [1, 1, 3, 1, 3, 3])])
    expect(next.map((o) => o.id)).toEqual(['d2', 'd3', 's1', 's2'])
    expect(next[2]).toBe(s1)
    expect(replaceDetections(next, []).map((o) => o.id)).toEqual(['s1', 's2'])
  })

  it('a manual eraser still wins over a detection added after it', () => {
    const img = noise(20, 20)
    const eraser = stroke({ tool: 'eraser', size: 6, points: [10, 10] })
    const ops = insertDetections([eraser], [region('d', 'yolo', [0, 0, 20, 0, 20, 20, 0, 20])])
    const out = renderOps(img, ops)
    expect(px(out, 10, 10)).toEqual(px(img, 10, 10))
    expect(px(out, 1, 1)).toEqual([0, 0, 0, 255])
  })

  it('covers polygon and run-length mask shapes', () => {
    const seen: number[] = []
    visitPolygon(10, 10, [2, 2, 6, 2, 6, 5, 2, 5], (i) => seen.push(i))
    expect(seen.length).toBe(12)
    const masked: number[] = []
    visitMask(10, 10, { x: 8, y: 0, w: 4, h: 2, runs: [1, 2, 1, 4] }, (i) => masked.push(i))
    // mask row 0 = [0,1,1,0] at x 8..11 -> only x 9 is inside the 10 px image; row 1 = [1,1,1,1] -> x 8, 9
    expect(masked).toEqual([9, 18, 19])
  })
})

describe('saved state', () => {
  it('reads valid ops, drops broken ones and puts detections first', () => {
    const ops = parseOps({
      censor: {
        v: 1,
        ops: [
          { type: 'stroke', id: 'a', tool: 'pen', style: 'mosaic', size: 999, block: 2, color: 'red', opacity: 5, points: [1, 2, 3, 4] },
          { type: 'stroke', points: [1] },
          { type: 'region', id: 'r', source: 'detection', detector: 'yolo', style: 'blur', block: 8, shape: { type: 'polygon', points: [0, 0, 1, 0, 1, 1] } },
          'junk',
        ],
      },
    })
    expect(ops.map((o) => o.id)).toEqual(['r', 'a'])
    expect(ops[1]).toMatchObject({ size: 200, block: 4, color: '#000000', opacity: 10 })
    expect(parseOps(null)).toEqual([])
    expect(parseOps({ other: 1 })).toEqual([])
  })

  it('keeps other steps state and drops censor when there are no ops', () => {
    const saved = { v: 1 as const, width: 2, height: 2, ops: [stroke({ points: [1, 1] })] }
    expect(withCensorState({ name: 'x' }, saved)).toEqual({ name: 'x', censor: saved })
    expect(withCensorState({ name: 'x', censor: 1 }, { ...saved, ops: [] })).toEqual({ name: 'x' })
    expect(withCensorState(null, null)).toEqual({})
  })

  it('skips pointer samples closer than an eighth of the brush', () => {
    expect(farEnough([], 1, 1, 40)).toBe(true)
    expect(farEnough([0, 0], 3, 0, 40)).toBe(false)
    expect(farEnough([0, 0], 5, 0, 40)).toBe(true)
  })
})

describe('history', () => {
  it('undoes and redoes op lists and forgets redo after a new change', () => {
    const a: Op[] = []
    const b: Op[] = [stroke({ points: [1, 1] })]
    const c: Op[] = [...b, stroke({ id: 't', points: [2, 2] })]
    let h = record(record(EMPTY_HISTORY, a), b)
    const u = undo(h, c)
    expect(u?.ops).toBe(b)
    h = u!.history
    const r = redo(h, b)
    expect(r?.ops).toBe(c)
    const again = record(h, b)
    expect(again.future).toEqual([])
    expect(undo(EMPTY_HISTORY, a)).toBeNull()
    expect(redo(EMPTY_HISTORY, a)).toBeNull()
  })
})
