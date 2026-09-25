/*
 * Censor edits: an ordered list of operations per image. Contract that the
 * AI-detection slice and the export rely on:
 *
 * 1. The picture is always `original + ops applied in list order`
 *    (renderOps). The list is the only edit state; the censored PNG is a bake
 *    of it and is saved next to it (batch item_state.censor).
 * 2. Every op is plain JSON in IMAGE pixels (never screen pixels), so zoom,
 *    reloads and a different screen replay it exactly.
 * 3. AI detection results are `region` ops with `source: 'detection'` (a
 *    polygon or a run-length mask). They always form a PREFIX of the list:
 *    detections render first, then every manual op in the order the user made
 *    it. A manual stroke, including an eraser that corrects a wrong detection,
 *    therefore always wins over what a detector produced.
 * 4. insertDetections adds regions to that prefix; replaceDetections
 *    (re-detect) swaps out the earlier detection ops (all, or one detector's)
 *    for new ones. Neither removes, changes or reorders a manual op. Manual ops
 *    are only ever appended (appendManual).
 * 5. Lists are immutable: every change makes a new list, so undo history is a
 *    stack of old lists and "unsaved" is simply `ops !== savedOps`.
 */

export type CensorStyle = 'mosaic' | 'blur' | 'black' | 'white'
export type Tool = 'brush' | 'pen' | 'eraser'

export const STYLES: readonly CensorStyle[] = ['mosaic', 'blur', 'black', 'white']
export const TOOLS: readonly Tool[] = ['brush', 'pen', 'eraser']

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
}

export type RegionShape =
  | { type: 'polygon'; points: number[] }
  | { type: 'mask'; x: number; y: number; w: number; h: number; runs: number[] }

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
}

export type Op = StrokeOp | RegionOp

/** What item_state.censor holds for one batch item. */
export interface SavedCensorState {
  v: 1
  width: number
  height: number
  ops: Op[]
}

let counter = 0

export function newOpId(): string {
  counter = (counter + 1) % 1_000_000
  return `${Date.now().toString(36)}-${counter.toString(36)}`
}

export function isDetection(op: Op): op is RegionOp {
  return op.type === 'region' && op.source === 'detection'
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
  const kept = ops.filter((op): op is RegionOp => isDetection(op) && !drop(op))
  const manual = ops.filter((op) => !isDetection(op))
  return [...kept, ...regions, ...manual]
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
  return {
    type: 'stroke',
    id: typeof o.id === 'string' ? o.id : newOpId(),
    tool: oneOf(o.tool, TOOLS, 'brush'),
    style: oneOf(o.style, STYLES, 'mosaic'),
    size: clamp(isNum(o.size) ? o.size : 30, SIZE_MIN, SIZE_MAX),
    block: clamp(isNum(o.block) ? Math.round(o.block) : 16, BLOCK_MIN, BLOCK_MAX),
    color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#000000',
    opacity: clamp(isNum(o.opacity) ? Math.round(o.opacity) : 100, OPACITY_MIN, OPACITY_MAX),
    points: o.points,
  }
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
  return {
    type: 'region',
    id: typeof o.id === 'string' ? o.id : newOpId(),
    source: 'detection',
    detector: typeof o.detector === 'string' ? o.detector : '',
    label: typeof o.label === 'string' ? o.label : '',
    style: oneOf(o.style, STYLES, 'mosaic'),
    block: clamp(isNum(o.block) ? Math.round(o.block) : 16, BLOCK_MIN, BLOCK_MAX),
    shape,
  }
}

/** The ops stored in an item's state; anything malformed is left out, detections moved to the front. */
export function parseOps(itemState: unknown): Op[] {
  const censor = itemState && typeof itemState === 'object' ? (itemState as Record<string, unknown>).censor : null
  const list = censor && typeof censor === 'object' ? (censor as Record<string, unknown>).ops : null
  if (!Array.isArray(list)) return []
  const ops: Op[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const op = o.type === 'stroke' ? parseStroke(o) : o.type === 'region' ? parseRegion(o) : null
    if (op) ops.push(op)
  }
  return replaceDetections(ops, ops.filter(isDetection))
}

/** The item state to send: every other step's keys kept, `censor` set (or removed when there are no ops). */
export function withCensorState(itemState: Record<string, unknown> | null, saved: SavedCensorState | null): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...(itemState ?? {}) }
  delete rest.censor
  return saved && saved.ops.length > 0 ? { ...rest, censor: saved } : rest
}
