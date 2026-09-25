import { applyBaseOps } from './adjust'
import { blendPixel, blurMargin, blurRect, mosaicCell, parseHex, type Effect } from './effects'
import { isBase, type BaseOp, type Op, type RegionOp, type StrokeOp } from './ops'
import { clipRect, cloneRaster, unionRect, visitCapsule, visitMask, visitPolygon, type Raster, type Rect, type Visit } from './raster'

// Applying ops to pixels. Live painting feeds a stroke to a Painter a few
// points at a time; replay (undo, reload, the saved copy) feeds whole ops.
// Both give the same bytes: every covered pixel gets its value from the
// picture as it was before the op, whatever order the pieces arrive in.
// Picture edits (filters, background removal) first turn the original into
// the base picture, which the eraser restores. The clone stamp copies the
// picture as it is just before its stroke (censoring included), from a
// snapshot, so it never un-censors anything and never copies its own output.

/** An op painted over part of the picture (everything but the picture edits). */
export type PaintOp = StrokeOp | RegionOp

export function effectOf(op: PaintOp): Effect {
  if (op.type === 'stroke' && op.tool === 'eraser') return { kind: 'restore' }
  if (op.type === 'stroke' && op.tool === 'clone') return { kind: 'clone', dx: op.offset?.[0] ?? 0, dy: op.offset?.[1] ?? 0 }
  if (op.type === 'stroke' && op.tool === 'pen') {
    const [r, g, b] = parseHex(op.color)
    return { kind: 'fill', r, g, b, alpha: op.opacity / 100 }
  }
  switch (op.style) {
    case 'mosaic':
      return { kind: 'mosaic', block: op.block }
    case 'blur':
      return { kind: 'blur', radius: op.block }
    case 'black':
      return { kind: 'fill', r: 0, g: 0, b: 0, alpha: 1 }
    case 'white':
      return { kind: 'fill', r: 255, g: 255, b: 255, alpha: 1 }
  }
}

/** Per-pixel marks of what the current op already covered; one per image, reused by every op. */
export interface Scratch {
  marks: Uint16Array
  stamp: number
}

export function createScratch(width: number, height: number): Scratch {
  return { marks: new Uint16Array(width * height), stamp: 0 }
}

function nextStamp(scratch: Scratch): number {
  scratch.stamp += 1
  if (scratch.stamp > 0xffff) {
    scratch.marks.fill(0)
    scratch.stamp = 1
  }
  return scratch.stamp
}

export interface Painter {
  /** Cover more: the next points of a stroke (flat x, y, ...); a region covers its shape on the first call. Returns what changed. */
  add(points: readonly number[]): Rect | null
}

/** `before`: the picture just before this op (blur and clone read it, so an op never reads its own output). */
function applyToFresh(effect: Effect, target: Raster, original: Raster, before: Raster | null, fresh: number[], rect: Rect): void {
  const d = target.data
  if (effect.kind === 'fill') {
    for (const i of fresh) blendPixel(d, i * 4, effect.r, effect.g, effect.b, effect.alpha)
  } else if (effect.kind === 'restore') {
    for (const i of fresh) d.set(original.data.subarray(i * 4, i * 4 + 4), i * 4)
  } else if (effect.kind === 'clone' && before) {
    const w = target.width
    for (const i of fresh) {
      const x = (i % w) + effect.dx
      const y = Math.floor(i / w) + effect.dy
      if (x < 0 || y < 0 || x >= w || y >= target.height) continue
      const s = (y * w + x) * 4
      d.set(before.data.subarray(s, s + 4), i * 4)
    }
  } else if (effect.kind === 'blur' && before) {
    const m = blurMargin(effect.radius)
    const region = clipRect(rect.x - m, rect.y - m, rect.x + rect.w + m, rect.y + rect.h + m, target.width, target.height)
    if (!region) return
    const blurred = blurRect(before, region, effect.radius)
    for (const i of fresh) {
      const x = i % target.width
      const y = (i - x) / target.width
      const q = ((y - region.y) * region.w + (x - region.x)) * 4
      d.set(blurred.subarray(q, q + 4), i * 4)
    }
  }
}

/** A painter for one op on `target`. `original` is the base picture (the eraser restores from it). */
export function createPainter(target: Raster, original: Raster, op: PaintOp, scratch?: Scratch): Painter {
  const { width, height } = target
  const effect = effectOf(op)
  const own = scratch ?? createScratch(width, height)
  const stamp = nextStamp(own)
  const before = effect.kind === 'blur' || effect.kind === 'clone' ? cloneRaster(target) : null
  const block = effect.kind === 'mosaic' ? effect.block : 1
  const cols = Math.ceil(width / block)
  const cells = effect.kind === 'mosaic' ? new Uint8Array(cols * Math.ceil(height / block)) : null

  const cover = (shape: (visit: Visit) => void): Rect | null => {
    if (cells) {
      let dirty: Rect | null = null
      shape((_i, x, y) => {
        const cx = Math.floor(x / block)
        const cy = Math.floor(y / block)
        if (cells[cy * cols + cx]) return
        cells[cy * cols + cx] = 1
        dirty = unionRect(dirty, mosaicCell(target, cx, cy, block))
      })
      return dirty
    }
    const fresh: number[] = []
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    shape((i, x, y) => {
      if (own.marks[i] === stamp) return
      own.marks[i] = stamp
      fresh.push(i)
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    })
    if (fresh.length === 0) return null
    const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
    applyToFresh(effect, target, original, before, fresh, rect)
    return rect
  }

  if (op.type === 'region') {
    let done = false
    return {
      add: () => {
        if (done) return null
        done = true
        const shape = op.shape
        return cover((visit) =>
          shape.type === 'polygon' ? visitPolygon(width, height, shape.points, visit) : visitMask(width, height, shape, visit),
        )
      },
    }
  }

  const radius = op.size / 2
  let last: [number, number] | null = null
  return {
    add: (points) =>
      cover((visit) => {
        for (let k = 0; k + 1 < points.length; k += 2) {
          const x = points[k] as number
          const y = points[k + 1] as number
          const [ax, ay] = last ?? [x, y]
          visitCapsule(width, height, ax, ay, x, y, radius, visit)
          last = [x, y]
        }
      }),
  }
}

/** Apply a whole op; returns what changed. */
export function applyOp(target: Raster, original: Raster, op: PaintOp, scratch?: Scratch): Rect | null {
  return createPainter(target, original, op, scratch).add(op.type === 'stroke' ? op.points : [])
}

/** The last base picture made, reused while the picture edits stay the same objects (strokes change often; filters rarely). */
export interface BaseCache {
  original: Raster | null
  ops: readonly BaseOp[]
  base: Raster | null
}

export const newBaseCache = (): BaseCache => ({ original: null, ops: [], base: null })

function baseFor(original: Raster, ops: readonly Op[], cache: BaseCache | undefined): Raster {
  const baseOps = ops.filter(isBase)
  const same = cache && cache.base && cache.original === original && cache.ops.length === baseOps.length && cache.ops.every((op, i) => op === baseOps[i])
  if (same && cache.base) return cache.base
  const base = applyBaseOps(original, baseOps)
  if (cache) Object.assign(cache, { original, ops: baseOps, base })
  return base
}

/**
 * Redraw `target` as `original` + `ops` (target is overwritten; same size as
 * original). Returns the base picture the strokes were painted against.
 */
export function renderInto(target: Raster, original: Raster, ops: readonly Op[], scratch?: Scratch, cache?: BaseCache): Raster {
  const base = baseFor(original, ops, cache)
  target.data.set(base.data)
  const shared = scratch ?? createScratch(original.width, original.height)
  for (const op of ops) if (!isBase(op) && !(op.type === 'region' && op.off)) applyOp(target, base, op, shared)
  return base
}

/** A new raster with `ops` applied to `original`. */
export function renderOps(original: Raster, ops: readonly Op[]): Raster {
  const target = cloneRaster(original)
  renderInto(target, original, ops)
  return target
}
