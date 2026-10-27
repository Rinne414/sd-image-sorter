import type { PointRow, Region } from './types'

// The cloud's numbers, without three.js: dot size, the central mass that the
// camera fit and the floor grid follow, the typed arrays the scene draws from,
// which region a dot belongs to, and where dots land on the canvas (the box
// and lasso select read projectPoints / dotsInRect / dotsInPolygon / nearestDot).

// World-unit dot size ~ 0.6 / sqrt(n): ~10 px dots with gaps at 500 points on
// a 1920 canvas, ~1.5 px dots that still draw the shape at 50k.
const POINT_SIZE_COEFF = 0.6
export const MIN_POINT_SIZE = 0.008
export const MAX_POINT_SIZE = 0.035
/** A dot standing for many pictures grows up to +40% (over 1..4 members, then flat). */
const MEMBER_SIZE_BONUS = 0.4
export const MAX_MEMBERS = 65535
const CORE_LOW = 0.02
const CORE_HIGH = 0.98
/** The floor grid sits this far outside the central mass. */
export const GRID_PAD = 0.03
const GRID_DIVISIONS = 10

export function basePointSize(count: number): number {
  const size = POINT_SIZE_COEFF / Math.sqrt(Math.max(count, 1))
  return Math.min(MAX_POINT_SIZE, Math.max(MIN_POINT_SIZE, size))
}

export interface CloudArrays {
  count: number
  positions: Float32Array
  sizes: Float32Array
  ids: Int32Array
  members: Uint16Array
}

/** Typed arrays straight from the compact rows (`layout` names their columns). */
export function cloudArrays(rows: readonly PointRow[], layout?: readonly string[]): CloudArrays {
  const names = layout && layout.length ? layout : ['id', 'x', 'y', 'z', 'members']
  const col = (name: string, fallback: number) => {
    const at = names.indexOf(name)
    return at >= 0 ? at : fallback
  }
  const [cid, cx, cy, cz, cm] = [col('id', 0), col('x', 1), col('y', 2), col('z', 3), col('members', 4)]
  const count = rows.length
  const positions = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  const ids = new Int32Array(count)
  const members = new Uint16Array(count)
  const base = basePointSize(count)
  for (let i = 0; i < count; i += 1) {
    const row = rows[i]!
    positions[i * 3] = row[cx] ?? 0
    positions[i * 3 + 1] = row[cy] ?? 0
    positions[i * 3 + 2] = row[cz] ?? 0
    ids[i] = row[cid] ?? 0
    const group = Math.min(MAX_MEMBERS, Math.max(1, row[cm] ?? 1))
    members[i] = group
    sizes[i] = base * (1 + (MEMBER_SIZE_BONUS * Math.min(group - 1, 3)) / 3)
  }
  return { count, positions, sizes, ids, members }
}

export interface Box {
  min: [number, number, number]
  max: [number, number, number]
}

/** The central mass (2nd to 98th percentile per axis): a few outliers do not stretch the fit or the grid. */
export function coreBox(positions: Float32Array, count: number): Box | null {
  if (count === 0) return null
  const min: [number, number, number] = [0, 0, 0]
  const max: [number, number, number] = [0, 0, 0]
  const values = new Float32Array(count)
  for (let axis = 0; axis < 3; axis += 1) {
    for (let i = 0; i < count; i += 1) values[i] = positions[i * 3 + axis]!
    values.sort()
    min[axis] = values[Math.floor((count - 1) * CORE_LOW)]!
    max[axis] = values[Math.ceil((count - 1) * CORE_HIGH)]!
  }
  return { min, max }
}

export interface Floor {
  /** Line segments of the floor grid (x, y, z per vertex). */
  vertices: number[]
  corners: [number, number, number][]
  floorY: number
  cloudTopY: number
}

/** A faint floor grid under the central mass (a box's corners would force the cloud small). */
export function floorGrid(core: Box): Floor {
  const x0 = core.min[0] - GRID_PAD
  const x1 = core.max[0] + GRID_PAD
  const z0 = core.min[2] - GRID_PAD
  const z1 = core.max[2] + GRID_PAD
  const y = core.min[1] - GRID_PAD * 1.5
  const vertices: number[] = []
  for (let step = 0; step <= GRID_DIVISIONS; step += 1) {
    const t = step / GRID_DIVISIONS
    const x = x0 + (x1 - x0) * t
    const z = z0 + (z1 - z0) * t
    vertices.push(x, y, z0, x, y, z1, x0, y, z, x1, y, z)
  }
  const corners: [number, number, number][] = [
    [x0, y, z0],
    [x1, y, z0],
    [x0, y, z1],
    [x1, y, z1],
  ]
  return { vertices, corners, floorY: y, cloudTopY: core.max[1] }
}

/** Which region each dot belongs to: the nearest region centre (Int8, -1 = none). */
export function assignRegions(positions: Float32Array, count: number, regions: readonly Pick<Region, 'center'>[]): Int8Array {
  const labels = new Int8Array(count).fill(-1)
  if (!count || !regions.length) return labels
  const centers = regions.map((r) => r.center ?? [0, 0, 0])
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3]!
    const y = positions[i * 3 + 1]!
    const z = positions[i * 3 + 2]!
    let best = -1
    let bestDistance = Infinity
    for (let r = 0; r < centers.length; r += 1) {
      const [cx, cy, cz] = centers[r]!
      const d = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2
      if (d < bestDistance) {
        bestDistance = d
        best = r
      }
    }
    labels[i] = best
  }
  return labels
}

/** The index of the dot of picture `id`, or -1. */
export function indexOfId(ids: ArrayLike<number>, id: number): number {
  for (let i = 0; i < ids.length; i += 1) if (ids[i] === id) return i
  return -1
}

/**
 * Where each dot lands on the canvas: 3 floats per dot (u, v in 0..1 with v
 * down, visible). `matrix` is projection x view (column-major, 16 numbers).
 * A dot behind the camera or outside the near / far planes is not visible.
 */
export function projectPoints(positions: Float32Array, count: number, matrix: ArrayLike<number>, out = new Float32Array(count * 3)): Float32Array {
  const m = matrix
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3]!
    const y = positions[i * 3 + 1]!
    const z = positions[i * 3 + 2]!
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
    const depth = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / (w || 1)
    const at = i * 3
    if (w <= 0 || depth < -1 || depth > 1) {
      out[at + 2] = 0
      continue
    }
    out[at] = ((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w + 1) / 2
    out[at + 1] = (1 - (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w) / 2
    out[at + 2] = 1
  }
  return out
}

export interface UV {
  u: number
  v: number
}

/** Indices of the visible dots inside the rectangle (corners in any order). */
export function dotsInRect(projected: Float32Array, count: number, a: UV, b: UV): number[] {
  const left = Math.min(a.u, b.u)
  const right = Math.max(a.u, b.u)
  const top = Math.min(a.v, b.v)
  const bottom = Math.max(a.v, b.v)
  const hits: number[] = []
  for (let i = 0; i < count; i += 1) {
    const at = i * 3
    if (!projected[at + 2]) continue
    const u = projected[at]!
    const v = projected[at + 1]!
    if (u >= left && u <= right && v >= top && v <= bottom) hits.push(i)
  }
  return hits
}

/** True when `point` lies inside the outline (even-odd rule; corners in drawing order, closed back to the first). */
export function insidePolygon(point: UV, polygon: readonly UV[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!
    const b = polygon[j]!
    if (a.v > point.v !== b.v > point.v && point.u < ((b.u - a.u) * (point.v - a.v)) / (b.v - a.v) + a.u) inside = !inside
  }
  return inside
}

/** Indices of the visible dots inside a drawn outline (the lasso); fewer than three corners hold nothing. */
export function dotsInPolygon(projected: Float32Array, count: number, polygon: readonly UV[]): number[] {
  if (polygon.length < 3) return []
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (const p of polygon) {
    left = Math.min(left, p.u)
    right = Math.max(right, p.u)
    top = Math.min(top, p.v)
    bottom = Math.max(bottom, p.v)
  }
  const hits: number[] = []
  const point = { u: 0, v: 0 }
  for (let i = 0; i < count; i += 1) {
    const at = i * 3
    if (!projected[at + 2]) continue
    point.u = projected[at]!
    point.v = projected[at + 1]!
    // Outside the outline's box: no need to walk its edges.
    if (point.u < left || point.u > right || point.v < top || point.v > bottom) continue
    if (insidePolygon(point, polygon)) hits.push(i)
  }
  return hits
}

/** The visible dot closest to `point` within `radiusPx` on a width x height canvas; -1 for none. */
export function nearestDot(projected: Float32Array, count: number, point: UV, size: { width: number; height: number; radiusPx: number }): number {
  let best = -1
  let bestDistance = size.radiusPx * size.radiusPx
  for (let i = 0; i < count; i += 1) {
    const at = i * 3
    if (!projected[at + 2]) continue
    const dx = (projected[at]! - point.u) * size.width
    const dy = (projected[at + 1]! - point.v) * size.height
    const distance = dx * dx + dy * dy
    if (distance <= bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}
