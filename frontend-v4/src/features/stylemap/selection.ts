// Picking dots on the map, as pure rules: what a press on the canvas draws
// (a box, a lasso or nothing: the map turns), which dots are picked, which
// picks survive a redrawn map, and which dots must be asked for the
// pictures merged into them. Ported from the classic page
// (frontend/js/style-map/lasso.js + selection.js); the store is pickStore.ts.

/** What a plain left-drag on the map does. */
export type DragMode = 'rotate' | 'box' | 'lasso'

export const DRAG_MODES: readonly DragMode[] = ['rotate', 'box', 'lasso']

export type DragShape = 'box' | 'lasso'

/** A press that moves less than this is a click, not a drag. */
export const CLICK_SLOP_PX = 4
/** A Shift + click reaches a dot this close. */
export const PICK_RADIUS_PX = 9

/**
 * The shape a left press draws, or null when it is left to the map (turn,
 * click). Shift + drag draws a box whatever the mode (as on the classic
 * page); with box or lasso chosen, a plain drag draws that shape.
 */
export function dragShape(mode: DragMode, shift: boolean, button: number): DragShape | null {
  if (button !== 0) return null
  if (mode !== 'rotate') return mode
  return shift ? 'box' : null
}

/** One flag per dot (point order): 1 when its picture id is picked. */
export function pickFlags(ids: ArrayLike<number>, picked: ReadonlySet<number>): Uint8Array {
  const flags = new Uint8Array(ids.length)
  if (picked.size === 0) return flags
  for (let i = 0; i < ids.length; i += 1) if (picked.has(ids[i]!)) flags[i] = 1
  return flags
}

/** The picture ids of the dots at these indices. */
export function idsAt(indices: readonly number[], ids: ArrayLike<number>): Set<number> {
  const out = new Set<number>()
  for (const index of indices) {
    const id = ids[index]
    if (id !== undefined) out.add(id)
  }
  return out
}

/** The pick with this dot added, or taken out when it was in. */
export function toggled(picked: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(picked)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** The picked dots that are still on a redrawn map. */
export function keptOnMap(picked: ReadonlySet<number>, ids: ArrayLike<number>): Set<number> {
  const onMap = new Set<number>()
  for (let i = 0; i < ids.length; i += 1) onMap.add(ids[i]!)
  const kept = new Set<number>()
  for (const id of picked) if (onMap.has(id)) kept.add(id)
  return kept
}

/**
 * The picked dots in point order, and whether any of them stands for more
 * pictures than itself (then the server is asked for the rest).
 */
export function pickedDots(ids: ArrayLike<number>, members: ArrayLike<number>, picked: ReadonlySet<number>): { reps: number[]; merged: boolean } {
  const reps: number[] = []
  let merged = false
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!
    if (!picked.has(id)) continue
    reps.push(id)
    if ((members[i] ?? 1) > 1) merged = true
  }
  return { reps, merged }
}

/** Every picture of the pick: the dots first, then the pictures merged into them, each once. */
export function withMembers(reps: readonly number[], members: readonly number[]): number[] {
  return [...new Set([...reps, ...members])]
}

/** The rectangle between two corners, as CSS percentages of the canvas. */
export function boxStyle(a: { u: number; v: number }, b: { u: number; v: number }): { left: string; top: string; width: string; height: string } {
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`
  return { left: pct(Math.min(a.u, b.u)), top: pct(Math.min(a.v, b.v)), width: pct(Math.abs(b.u - a.u)), height: pct(Math.abs(b.v - a.v)) }
}

/** The lasso's corners as SVG points on a 0..100 square. */
export function lassoPoints(points: readonly { u: number; v: number }[]): string {
  return points.map((p) => `${(p.u * 100).toFixed(2)},${(p.v * 100).toFixed(2)}`).join(' ')
}
