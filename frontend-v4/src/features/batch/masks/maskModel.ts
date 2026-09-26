import type { StrokeOp } from '../../censor/ops'
import { applyOp, createScratch, type Scratch } from '../../censor/paint'
import { cloneRaster, createRaster, type Raster } from '../../censor/raster'

// A training mask as the editor keeps it: a starting picture (the stored or an
// automatic mask, or "everything trained") and the changes made on top of it.
// The mask travels as grey pixels: white = the trainer learns this part,
// black = it is left out. Strokes are painted by the censor editor's painter
// (a pen stroke at full opacity), so live painting and replay give the same
// pixels. Pure: no canvas, no requests.

export type MaskTool = 'keep' | 'drop'

export type MaskAction = { kind: 'stroke'; tool: MaskTool; size: number; points: number[] } | { kind: 'invert' }
export type MaskStroke = Extract<MaskAction, { kind: 'stroke' }>

export interface MaskState {
  /** The starting mask; null: every pixel trained. Shared, never changed. */
  base: Raster | null
  actions: MaskAction[]
}

/** Grey levels of the two brushes. */
export const KEEP = 255
export const DROP = 0

const grey = (v: number) => `#${v.toString(16).padStart(2, '0').repeat(3)}`

/** A mask brush stroke as the censor painter's pen stroke. */
export function strokeOp(action: MaskStroke): StrokeOp {
  return {
    type: 'stroke',
    id: 'mask',
    tool: 'pen',
    style: 'black',
    size: action.size,
    block: 1,
    color: grey(action.tool === 'keep' ? KEEP : DROP),
    opacity: 100,
    points: action.points,
  }
}

export function fullMask(width: number, height: number, value = KEEP): Raster {
  const out = createRaster(width, height)
  const d = out.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = value
    d[i + 1] = value
    d[i + 2] = value
    d[i + 3] = 255
  }
  return out
}

export function invertInPlace(mask: Raster): void {
  const d = mask.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - (d[i] as number)
    d[i + 1] = 255 - (d[i + 1] as number)
    d[i + 2] = 255 - (d[i + 2] as number)
  }
}

/** Replay a state onto `target` (overwritten; the state's size). */
export function renderInto(target: Raster, state: MaskState, scratch?: Scratch): void {
  if (state.base) target.data.set(state.base.data)
  else target.data.set(fullMask(target.width, target.height).data)
  const shared = scratch ?? createScratch(target.width, target.height)
  for (const action of state.actions) {
    if (action.kind === 'invert') invertInPlace(target)
    else applyOp(target, target, strokeOp(action), shared)
  }
}

export function renderMask(width: number, height: number, state: MaskState): Raster {
  const out = state.base ? cloneRaster(state.base) : createRaster(width, height)
  renderInto(out, state)
  return out
}

export const grayValue = (mask: Raster, x: number, y: number): number => mask.data[(y * mask.width + x) * 4] as number

/** The share of the picture that is trained (1: all of it). */
export function coverage(mask: Raster): number {
  const d = mask.data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) sum += d[i] as number
  return d.length ? sum / 255 / (d.length / 4) : 1
}

// ---- undo / redo: whole states (the base pictures are shared, not copied) ----

export interface MaskHistory {
  past: MaskState[]
  future: MaskState[]
}

export const pushState = (h: MaskHistory, before: MaskState): MaskHistory => ({ past: [...h.past, before], future: [] })

export function undoState(h: MaskHistory, current: MaskState): { state: MaskState; history: MaskHistory } | null {
  const state = h.past.at(-1)
  return state ? { state, history: { past: h.past.slice(0, -1), future: [...h.future, current] } } : null
}

export function redoState(h: MaskHistory, current: MaskState): { state: MaskState; history: MaskHistory } | null {
  const state = h.future.at(-1)
  return state ? { state, history: { past: [...h.past, current], future: h.future.slice(0, -1) } } : null
}
