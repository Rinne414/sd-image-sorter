/*
 * Censor edits: an ordered list of operations per image. Contract that the
 * AI-detection slice and the export rely on:
 *
 * 1. The picture is always `original + ops applied in list order`
 *    (renderOps). The list is the only edit state; the censored PNG is a bake
 *    of it and is saved next to it (batch item_state.censor).
 * 2. Every op is plain JSON in IMAGE pixels (never screen pixels), so zoom,
 *    reloads and a different screen replay it exactly.
 * 3. The list has three groups, always in this order:
 *    a. picture edits (`adjust` filters, `background` removal), in the order
 *       made. They turn the original into the BASE picture: what the eraser
 *       restores and the clone stamp samples, and what censoring covers;
 *    b. AI detection results: `region` ops with `source: 'detection'` (a
 *       polygon or a run-length mask);
 *    c. manual strokes, in the order the user made them.
 *    A manual stroke, including an eraser that corrects a wrong detection,
 *    therefore always wins over what a detector produced, and a filter never
 *    lightens a black bar or un-blurs a mosaic.
 * 4. appendBase adds a picture edit at the end of group a; insertDetections
 *    and replaceDetections (re-detect) change group b only (all detections, or
 *    one detector's). Manual ops are only ever appended (appendManual). None
 *    of them removes, changes or reorders an op of another group.
 * 5. Lists are immutable: every change makes a new list, so undo history is a
 *    stack of old lists and "unsaved" is simply `ops !== savedOps`.
 * 6. A detection switched off in review keeps its place in the list with
 *    `off: true` and is skipped when rendering; switching it on again brings it back.
 */

export type CensorStyle = 'mosaic' | 'blur' | 'black' | 'white'
export type Tool = 'brush' | 'pen' | 'eraser' | 'clone'

export const STYLES: readonly CensorStyle[] = ['mosaic', 'blur', 'black', 'white']
export const TOOLS: readonly Tool[] = ['brush', 'pen', 'eraser', 'clone']

export const SIZE_MIN = 5
export const SIZE_MAX = 200
export const BLOCK_MIN = 4
export const BLOCK_MAX = 64
export const OPACITY_MIN = 10
export const OPACITY_MAX = 100

/** A hand-drawn stroke. `style` matters for the brush; `color`/`opacity` for the pen. */
export interface StrokeOp {
  type: 'stroke'
  id: string
  tool: Tool
  style: CensorStyle
  /** Brush diameter in image pixels. */
  size: number
  /** Mosaic cell size in image pixels; also the blur radius. */
  block: number
  /** '#rrggbb' */
  color: string
  /** Percent, 10-100. */
  opacity: number
  /** Flat x0, y0, x1, y1, ... in image pixels. */
  points: number[]
  /** Clone stamp: where it copies from, as whole pixels from each stroke point (source minus point). */
  offset?: [number, number]
}

export type RegionShape =
  | { type: 'polygon'; points: number[] }
  | { type: 'mask'; x: number; y: number; w: number; h: number; runs: number[] }

/** A detector's box: x1, y1, x2, y2 in image pixels. */
export type Box = [number, number, number, number]

/** An area a detector found, censored with `style`. */
export interface RegionOp {
  type: 'region'
  id: string
  source: 'detection'
  /** Which detector produced it; re-detecting with the same one replaces these. */
  detector: string
  label: string
  style: CensorStyle
  block: number
  shape: RegionShape
  /** The detector's score 0-1, when it gave one. */
  confidence?: number
  /** The detector's box (SAM3 refines from it). */
  box?: Box
  /** Switched off in review: still listed, not applied. */
  off?: boolean
}

/** The picture filters of the Adjust tab. 0 everywhere changes nothing. */
export type AdjustKey = 'brightness' | 'contrast' | 'saturation' | 'hue' | 'blur' | 'sharpen' | 'temperature' | 'vignette'
export type AdjustValues = Record<AdjustKey, number>

export const ADJUST_KEYS: readonly AdjustKey[] = ['brightness', 'contrast', 'saturation', 'hue', 'blur', 'sharpen', 'temperature', 'vignette']

/** Slider ranges (V3.5's): min, max, step. */
export const ADJUST_RANGE: Record<AdjustKey, readonly [number, number, number]> = {
  brightness: [-100, 100, 5],
  contrast: [-100, 100, 5],
  saturation: [-100, 100, 5],
  hue: [0, 360, 5],
  blur: [0, 20, 1],
  sharpen: [0, 100, 5],
  temperature: [-50, 50, 5],
  vignette: [0, 100, 5],
}

export const NO_ADJUST: AdjustValues = { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, sharpen: 0, temperature: 0, vignette: 0 }

/** Filters over the whole picture (group a). */
export interface AdjustOp {
  type: 'adjust'
  id: string
  values: AdjustValues
}

export type BackgroundFill = 'transparent' | 'white' | 'black'
export const BACKGROUND_FILLS: readonly BackgroundFill[] = ['transparent', 'white', 'black']

/** Background removal (group a): every pixel outside the foreground mask becomes `fill`. */
export interface BackgroundOp {
  type: 'background'
  id: string
  fill: BackgroundFill
  /** The foreground (what stays), as a run-length mask. */
  mask: { x: number; y: number; w: number; h: number; runs: number[] }
}

/** A picture edit: changes the whole picture, before any censoring. */
export type BaseOp = AdjustOp | BackgroundOp

export type Op = StrokeOp | RegionOp | BaseOp

/** What item_state.censor holds for one batch item. */
export interface SavedCensorState {
  v: 1
  width: number
  height: number
  ops: Op[]
  /** Absent: never detected. false: detected, waiting for review. true: approved in review. */
  reviewed?: boolean
}

let counter = 0

export function newOpId(): string {
  counter = (counter + 1) % 1_000_000
  return `${Date.now().toString(36)}-${counter.toString(36)}`
}

export function isDetection(op: Op): op is RegionOp {
  return op.type === 'region' && op.source === 'detection'
}

export function isBase(op: Op): op is BaseOp {
  return op.type === 'adjust' || op.type === 'background'
}

/** A picture edit goes after the earlier picture edits, before every detection and stroke. */
export function appendBase(ops: readonly Op[], op: BaseOp): Op[] {
  const base = ops.filter(isBase)
  return [...base, op, ...ops.filter((o) => !isBase(o))]
}

/** A manual op always goes after everything that is already there. */
export function appendManual(ops: readonly Op[], op: StrokeOp): Op[] {
  return [...ops, op]
}

/** Add detection regions to the detection prefix; manual ops stay as they are. */
export function insertDetections(ops: readonly Op[], regions: readonly RegionOp[]): Op[] {
  return replaceDetections(ops, regions, () => false)
}

/**
 * Re-detect: drop the earlier detection ops that `drop` selects (by default
 * all of them) and put `regions` at the end of the detection prefix.
 */
export function replaceDetections(
  ops: readonly Op[],
  regions: readonly RegionOp[],
  drop: (op: RegionOp) => boolean = () => true,
): Op[] {
  const base = ops.filter(isBase)
  const kept = ops.filter((op): op is RegionOp => isDetection(op) && !drop(op))
  const manual = ops.filter((op) => !isDetection(op) && !isBase(op))
  return [...base, ...kept, ...regions, ...manual]
}

/** Replace one detector's earlier regions with its new ones. */
export function redetect(ops: readonly Op[], detector: string, regions: readonly RegionOp[]): Op[] {
  return replaceDetections(ops, regions, (op) => op.detector === detector)
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Keep a pointer sample only when it moved far enough to matter at this brush size. */
export function farEnough(points: readonly number[], x: number, y: number, size: number): boolean {
  if (points.length < 2) return true
  const dx = x - (points[points.length - 2] as number)
  const dy = y - (points[points.length - 1] as number)
  const step = Math.max(1, size / 8)
  return dx * dx + dy * dy >= step * step
}

/** Image pixels rounded to 0.1 px keeps the saved JSON small without moving a stroke visibly. */
export function roundPoint(v: number): number {
  return Math.round(v * 10) / 10
}

// ---- reading ops back from the server (untrusted JSON) ----

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numList = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum)
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback

function parseStroke(o: Record<string, unknown>): StrokeOp | null {
  if (!numList(o.points) || o.points.length < 2 || o.points.length % 2 !== 0) return null
  const tool = oneOf(o.tool, TOOLS, 'brush')
  const offset = numList(o.offset) && o.offset.length === 2 ? ([Math.round(o.offset[0] as number), Math.round(o.offset[1] as number)] as [number, number]) : null
  // A clone stroke without a source copies nothing: left out.
  if (tool === 'clone' && !offset) return null
  const stroke: StrokeOp = {
    type: 'stroke',
    id: typeof o.id === 'string' ? o.id : newOpId(),
    tool,
    style: oneOf(o.style, STYLES, 'mosaic'),
    size: clamp(isNum(o.size) ? o.size : 30, SIZE_MIN, SIZE_MAX),
    block: clamp(isNum(o.block) ? Math.round(o.block) : 16, BLOCK_MIN, BLOCK_MAX),
    color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#000000',
    opacity: clamp(isNum(o.opacity) ? Math.round(o.opacity) : 100, OPACITY_MIN, OPACITY_MAX),
    points: o.points,
  }
  return tool === 'clone' && offset ? { ...stroke, offset } : stroke
}

function parseAdjust(o: Record<string, unknown>): AdjustOp | null {
  const raw = o.values && typeof o.values === 'object' ? (o.values as Record<string, unknown>) : null
  if (!raw) return null
  const values = { ...NO_ADJUST }
  for (const key of ADJUST_KEYS) {
    const [lo, hi] = ADJUST_RANGE[key]
    const v = raw[key]
    values[key] = isNum(v) ? clamp(Math.round(v), lo, hi) : 0
  }
  return { type: 'adjust', id: typeof o.id === 'string' ? o.id : newOpId(), values }
}

function parseBackground(o: Record<string, unknown>): BackgroundOp | null {
  const shape = parseShape({ ...(o.mask as object), type: 'mask' })
  if (!shape || shape.type !== 'mask') return null
  const { x, y, w, h, runs } = shape
  return { type: 'background', id: typeof o.id === 'string' ? o.id : newOpId(), fill: oneOf(o.fill, BACKGROUND_FILLS, 'transparent'), mask: { x, y, w, h, runs } }
}

function parseShape(v: unknown): RegionShape | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  if (s.type === 'polygon' && numList(s.points) && s.points.length >= 6) return { type: 'polygon', points: s.points }
  if (s.type === 'mask' && isNum(s.x) && isNum(s.y) && isNum(s.w) && isNum(s.h) && s.w > 0 && s.h > 0 && numList(s.runs)) {
    return { type: 'mask', x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.w), h: Math.round(s.h), runs: s.runs }
  }
  return null
}

function parseRegion(o: Record<string, unknown>): RegionOp | null {
  const shape = parseShape(o.shape)
  if (!shape || o.source !== 'detection') return null
  const region: RegionOp = {
    type: 'region',
    id: typeof o.id === 'string' ? o.id : newOpId(),
    source: 'detection',
    detector: typeof o.detector === 'string' ? o.detector : '',
    label: typeof o.label === 'string' ? o.label : '',
    style: oneOf(o.style, STYLES, 'mosaic'),
    block: clamp(isNum(o.block) ? Math.round(o.block) : 16, BLOCK_MIN, BLOCK_MAX),
    shape,
  }
  if (isNum(o.confidence)) region.confidence = clamp(o.confidence, 0, 1)
  if (numList(o.box) && o.box.length === 4) region.box = [o.box[0], o.box[1], o.box[2], o.box[3]] as Box
  if (o.off === true) region.off = true
  return region
}

const censorOf = (itemState: unknown): Record<string, unknown> | null => {
  const censor = itemState && typeof itemState === 'object' ? (itemState as Record<string, unknown>).censor : null
  return censor && typeof censor === 'object' ? (censor as Record<string, unknown>) : null
}

/** The review mark stored with an item: null when it was never detected. */
export function parseReviewed(itemState: unknown): boolean | null {
  const reviewed = censorOf(itemState)?.reviewed
  return typeof reviewed === 'boolean' ? reviewed : null
}

const PARSERS: Record<string, (o: Record<string, unknown>) => Op | null> = {
  stroke: parseStroke,
  region: parseRegion,
  adjust: parseAdjust,
  background: parseBackground,
}

/** The ops stored in an item's state; anything malformed is left out, the three groups put in order. */
export function parseOps(itemState: unknown): Op[] {
  const list = censorOf(itemState)?.ops
  if (!Array.isArray(list)) return []
  const ops: Op[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const op = typeof o.type === 'string' ? (PARSERS[o.type]?.(o) ?? null) : null
    if (op) ops.push(op)
  }
  return replaceDetections(ops, ops.filter(isDetection))
}

/**
 * The item state to send: every other step's keys kept, `censor` set, or
 * removed when there is nothing to keep (no ops and no review mark).
 */
export function withCensorState(itemState: Record<string, unknown> | null, saved: SavedCensorState | null): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...(itemState ?? {}) }
  delete rest.censor
  return saved && (saved.ops.length > 0 || saved.reviewed !== undefined) ? { ...rest, censor: saved } : rest
}
