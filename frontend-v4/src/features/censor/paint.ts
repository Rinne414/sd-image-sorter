import { blendPixel, blurMargin, blurRect, mosaicCell, parseHex, type Effect } from './effects'
import type { Op } from './ops'
import { clipRect, cloneRaster, unionRect, visitCapsule, visitMask, visitPolygon, type Raster, type Rect, type Visit } from './raster'

// Applying ops to pixels. Live painting feeds a stroke to a Painter a few
// points at a time; replay (undo, reload, the saved copy) feeds whole ops.
// Both give the same bytes: every covered pixel gets its value from the
// picture as it was before the op, whatever order the pieces arrive in.

export function effectOf(op: Op): Effect {
  if (op.type === 'stroke' && op.tool === 'eraser') return { kind: 'restore' }
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

function applyToFresh(effect: Effect, target: Raster, original: Raster, base: Raster | null, fresh: number[], rect: Rect): void {
  const d = target.data
  if (effect.kind === 'fill') {
    for (const i of fresh) blendPixel(d, i * 4, effect.r, effect.g, effect.b, effect.alpha)
  } else if (effect.kind === 'restore') {
    for (const i of fresh) d.set(original.data.subarray(i * 4, i * 4 + 4), i * 4)
  } else if (effect.kind === 'blur' && base) {
    const m = blurMargin(effect.radius)
    const region = clipRect(rect.x - m, rect.y - m, rect.x + rect.w + m, rect.y + rect.h + m, target.width, target.height)
    if (!region) return
    const blurred = blurRect(base, region, effect.radius)
    for (const i of fresh) {
      const x = i % target.width
      const y = (i - x) / target.width
      const q = ((y - region.y) * region.w + (x - region.x)) * 4
      d.set(blurred.subarray(q, q + 4), i * 4)
    }
  }
}

/** A painter for one op on `target`. `original` is the untouched image (the eraser restores from it). */
export function createPainter(target: Raster, original: Raster, op: Op, scratch?: Scratch): Painter {
  const { width, height } = target
  const effect = effectOf(op)
  const own = scratch ?? createScratch(width, height)
  const stamp = nextStamp(own)
  const base = effect.kind === 'blur' ? cloneRaster(target) : null
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
    applyToFresh(effect, target, original, base, fresh, rect)
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
export function applyOp(target: Raster, original: Raster, op: Op, scratch?: Scratch): Rect | null {
  return createPainter(target, original, op, scratch).add(op.type === 'stroke' ? op.points : [])
}

/** Redraw `target` as `original` + `ops` (target is overwritten; same size as original). */
export function renderInto(target: Raster, original: Raster, ops: readonly Op[], scratch?: Scratch): void {
  target.data.set(original.data)
  const shared = scratch ?? createScratch(original.width, original.height)
  for (const op of ops) applyOp(target, original, op, shared)
}

/** A new raster with `ops` applied to `original`. */
export function renderOps(original: Raster, ops: readonly Op[]): Raster {
  const target = cloneRaster(original)
  renderInto(target, original, ops)
  return target
}
