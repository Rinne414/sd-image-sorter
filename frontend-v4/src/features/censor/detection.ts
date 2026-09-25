import { isDetection, newOpId, replaceDetections, type Box, type CensorStyle, type Op, type RegionOp, type RegionShape } from './ops'

// Turning what the detectors answer into region ops, and the list changes a
// review makes. Pure (no canvas, no network) so the rules can be tested:
// - /api/censor/detect gives boxes (+ a polygon for YOLO -seg models) and one
//   combined mask of everything it found; a precise region is the combined
//   mask inside its own box, so each region can be switched off on its own.
// - Box shape ignores masks and polygons: the rectangle is censored.
// - Every change goes through replaceDetections, so manual strokes are never
//   touched (ops.ts, point 4).

export type MaskShape = 'precise' | 'box'

/** A mask as one bit per pixel over the rectangle (x, y, w, h) of the image. */
export interface MaskBitmap {
  x: number
  y: number
  w: number
  h: number
  bits: Uint8Array
}

/** One detection as /api/censor/detect sends it (untrusted JSON). */
export interface RawDetection {
  box?: unknown
  polygon?: unknown
  class?: unknown
  label?: unknown
  confidence?: unknown
}

export interface RegionOptions {
  detector: string
  style: CensorStyle
  block: number
  maskShape: MaskShape
  /** Detections scoring below this are left out. */
  confidence: number
  width: number
  height: number
}

/** Mask pixels: a PNG where either alpha (data URL masks) or grey (cached masks) carries the mask. */
export function bitmapFromRgba(rgba: ArrayLike<number>, w: number, h: number, x: number, y: number): MaskBitmap {
  const bits = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bits[i] = Math.min(rgba[i * 4 + 3] as number, rgba[i * 4] as number) >= 128 ? 1 : 0
  return { x, y, w, h, bits }
}

/** A mask from the alpha channel only (a picture whose background was made transparent). */
export function alphaBitmap(rgba: ArrayLike<number>, w: number, h: number): MaskBitmap {
  const bits = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bits[i] = (rgba[i * 4 + 3] as number) >= 128 ? 1 : 0
  return { x: 0, y: 0, w, h, bits }
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A detector box clipped to the image; null when nothing of it is inside. */
export function readBox(v: unknown, width: number, height: number): Box | null {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(num)) return null
  const [a, b, c, d] = v as number[]
  const x1 = Math.max(0, Math.min(width, Math.min(a as number, c as number)))
  const x2 = Math.max(0, Math.min(width, Math.max(a as number, c as number)))
  const y1 = Math.max(0, Math.min(height, Math.min(b as number, d as number)))
  const y2 = Math.max(0, Math.min(height, Math.max(b as number, d as number)))
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null
}

export function boxShape(box: Box): RegionShape {
  const [x1, y1, x2, y2] = box
  return { type: 'polygon', points: [x1, y1, x2, y1, x2, y2, x1, y2] }
}

function polygonShape(v: unknown): RegionShape | null {
  if (!Array.isArray(v)) return null
  const points: number[] = []
  for (const p of v) if (Array.isArray(p) && num(p[0]) && num(p[1])) points.push(p[0], p[1])
  return points.length >= 6 ? { type: 'polygon', points } : null
}

/**
 * The set pixels of `bitmap` inside `box`, as a run-length mask trimmed to
 * them (runs alternate unset/set, row by row, starting unset); null when none are set.
 */
export function maskInBox(bitmap: MaskBitmap, box: Box): RegionShape | null {
  const left = Math.max(bitmap.x, Math.floor(box[0]))
  const top = Math.max(bitmap.y, Math.floor(box[1]))
  const right = Math.min(bitmap.x + bitmap.w, Math.ceil(box[2]))
  const bottom = Math.min(bitmap.y + bitmap.h, Math.ceil(box[3]))
  const at = (x: number, y: number) => bitmap.bits[(y - bitmap.y) * bitmap.w + (x - bitmap.x)] === 1
  // The box and the mask do not overlap at all.
  if (right <= left || bottom <= top) return null
  let x0 = right
  let y0 = bottom
  let x1 = left - 1
  let y1 = top - 1
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      if (!at(x, y)) continue
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
  }
  if (x1 < x0) return null
  const runs: number[] = []
  let set = false
  let run = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (at(x, y) === set) run++
      else {
        runs.push(run)
        set = !set
        run = 1
      }
    }
  }
  runs.push(run)
  return { type: 'mask', x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, runs }
}

/** The whole bitmap as a region shape (SAM3 refine and text segmentation). */
export function maskShapeOf(bitmap: MaskBitmap): RegionShape | null {
  return maskInBox(bitmap, [bitmap.x, bitmap.y, bitmap.x + bitmap.w, bitmap.y + bitmap.h])
}

function shapeFor(d: RawDetection, box: Box, o: RegionOptions, mask: MaskBitmap | null): RegionShape {
  if (o.maskShape === 'box') return boxShape(box)
  return polygonShape(d.polygon) ?? (mask ? maskInBox(mask, box) : null) ?? boxShape(box)
}

const labelOf = (d: RawDetection) =>
  (typeof d.class === 'string' && d.class) || (typeof d.label === 'string' && d.label) || 'region'

/** Region ops for a detect answer, most confident first; detections below the confidence or without a box are left out. */
export function regionsFromDetections(detections: readonly RawDetection[], o: RegionOptions, mask: MaskBitmap | null): RegionOp[] {
  const out: RegionOp[] = []
  for (const d of detections) {
    const confidence = num(d.confidence) ? d.confidence : 0
    const box = readBox(d.box, o.width, o.height)
    if (!box || confidence < o.confidence) continue
    const shape = shapeFor(d, box, o, mask)
    out.push({ type: 'region', id: newOpId(), source: 'detection', detector: o.detector, label: labelOf(d), style: o.style, block: o.block, shape, confidence, box })
  }
  return out.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
}

// ---- which detections a new run replaces ----

/** Text segmentation regions are named after their prompt; a detector run never replaces them. */
export const TEXT_PREFIX = 'text:'

export const textDetector = (prompt: string) => `${TEXT_PREFIX}${prompt.trim().toLowerCase()}`

export const isTextRegion = (op: RegionOp) => op.detector.startsWith(TEXT_PREFIX)

/** Detect / re-detect: the detector's regions replace every earlier detector region; text ones stay. */
export function applyDetectRun(ops: readonly Op[], regions: readonly RegionOp[]): Op[] {
  return replaceDetections(ops, regions, (op) => !isTextRegion(op))
}

/** Text segmentation: the prompt's regions replace that prompt's earlier ones. */
export function applyTextRun(ops: readonly Op[], detector: string, regions: readonly RegionOp[]): Op[] {
  return replaceDetections(ops, regions, (op) => op.detector === detector)
}

/** SAM3 refine: regions get a new shape in place (same id, same place in the list). */
export function applyRefined(ops: readonly Op[], shapes: ReadonlyMap<string, RegionShape>): Op[] {
  if (shapes.size === 0) return [...ops]
  return ops.map((op) => {
    const shape = isDetection(op) ? shapes.get(op.id) : undefined
    return shape && isDetection(op) ? { ...op, shape } : op
  })
}

// ---- review: switching regions off and on ----

export function detectionsOf(ops: readonly Op[]): RegionOp[] {
  return ops.filter(isDetection)
}

/** Switch one region off or on; it keeps its place and stays listed. */
export function setRegionOff(ops: readonly Op[], id: string, off: boolean): Op[] {
  return ops.map((op) => {
    if (!isDetection(op) || op.id !== id || !!op.off === off) return op
    if (off) return { ...op, off: true }
    const { off: _dropped, ...on } = op
    return on
  })
}

/** A: every region off when any is on, else every region on. */
export function toggleAllRegions(ops: readonly Op[]): Op[] {
  const anyOn = detectionsOf(ops).some((op) => !op.off)
  let next: Op[] = [...ops]
  for (const op of detectionsOf(ops)) next = setRegionOff(next, op.id, anyOn)
  return next
}

/** Boxes SAM3 can refine: regions with a detector box, not text regions. */
export function refinable(ops: readonly Op[]): (RegionOp & { box: Box })[] {
  return detectionsOf(ops).filter((op): op is RegionOp & { box: Box } => !!op.box && !isTextRegion(op))
}
