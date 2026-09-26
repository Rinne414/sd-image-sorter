import type { PickSelection } from './pickLogic'

// Box (marquee) selection in a batch's grids, as V3.5's queue had it: a drag
// that starts on empty space draws a box, and every picture it touches joins
// the selection; what Ctrl/Shift clicks picked before the drag stays picked.
// Coordinates are in the grid's scrolled content. Pure; useMarquee.ts drives it.

export interface Point {
  x: number
  y: number
}

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface TileRect {
  key: string
  rect: Rect
}

/** Pixels the pointer must move before a press on empty space becomes a box. */
export const DRAG_THRESHOLD = 4

export function boxOf(a: Point, b: Point): Rect {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) }
}

export function isDrag(from: Point, to: Point): boolean {
  return Math.abs(to.x - from.x) > DRAG_THRESHOLD || Math.abs(to.y - from.y) > DRAG_THRESHOLD
}

const overlaps = (a: Rect, b: Rect) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)

/** Keys of the tiles the box touches, in the tiles' order. */
export function hitKeys(tiles: readonly TileRect[], box: Rect): string[] {
  return tiles.filter((tile) => overlaps(tile.rect, box)).map((tile) => tile.key)
}

export interface GridLayout {
  cols: number
  tileW: number
  /** A row's height including the gap under it. */
  rowH: number
  gap: number
  pad: number
}

/** Where each tile of a fixed grid sits (the virtual pick grid draws only some; the box sees them all). */
export function gridRects(keys: readonly string[], g: GridLayout): TileRect[] {
  return keys.map((key, i) => {
    const left = g.pad + (i % g.cols) * (g.tileW + g.gap)
    const top = g.pad + Math.floor(i / g.cols) * g.rowH
    return { key, rect: { left, top, right: left + g.tileW, bottom: top + g.rowH - g.gap } }
  })
}

/** The selection while boxing: what was picked when the drag began plus what the box touches now. */
export function marqueeSelection(base: PickSelection, hit: readonly string[]): PickSelection {
  if (hit.length === 0) return base
  return { keys: new Set([...base.keys, ...hit]), anchor: base.anchor }
}

/** Band along the top and bottom edge where boxing scrolls the grid. */
const EDGE = 40
const MAX_STEP = 24

/** Pixels to scroll per frame for a pointer at `y` (client) over a grid shown from `top` to `bottom`. */
export function edgeScroll(y: number, top: number, bottom: number): number {
  if (y < top + EDGE) return -Math.min(MAX_STEP, Math.ceil((top + EDGE - y) / 4))
  if (y > bottom - EDGE) return Math.min(MAX_STEP, Math.ceil((y - (bottom - EDGE)) / 4))
  return 0
}
