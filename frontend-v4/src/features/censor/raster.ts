// Pixel buffers and the shapes that decide which pixels an edit touches.
// Pure functions over typed arrays: no canvas, so vitest can check them.

/** RGBA pixels, row-major, 4 bytes per pixel, straight (not premultiplied) alpha. */
export interface Raster {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray<ArrayBuffer>
}

/** A pixel rectangle; `w`/`h` are at least 1. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function createRaster(width: number, height: number, data?: Uint8ClampedArray<ArrayBuffer>): Raster {
  const size = width * height * 4
  if (data && data.length !== size) throw new Error(`Raster data is ${data.length} bytes, expected ${size}`)
  return { width, height, data: data ?? new Uint8ClampedArray(size) }
}

export function cloneRaster(raster: Raster): Raster {
  return { width: raster.width, height: raster.height, data: new Uint8ClampedArray(raster.data) }
}

/** The part of [x0, x1) x [y0, y1) inside a width x height image, or null when nothing is left. */
export function clipRect(x0: number, y0: number, x1: number, y1: number, width: number, height: number): Rect | null {
  const left = Math.max(0, Math.floor(x0))
  const top = Math.max(0, Math.floor(y0))
  const right = Math.min(width, Math.ceil(x1))
  const bottom = Math.min(height, Math.ceil(y1))
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/** Calls `visit(pixelIndex, x, y)` for every pixel inside the image. */
export type Visit = (index: number, x: number, y: number) => void

/**
 * Pixels whose centre lies within `radius` of the segment a-b (a disc when
 * a = b), clipped to the image. This is one piece of a brush stroke.
 */
export function visitCapsule(
  width: number,
  height: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
  visit: Visit,
): void {
  const box = clipRect(Math.min(ax, bx) - radius, Math.min(ay, by) - radius, Math.max(ax, bx) + radius, Math.max(ay, by) + radius, width, height)
  if (!box) return
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const r2 = radius * radius
  for (let y = box.y; y < box.y + box.h; y++) {
    const py = y + 0.5 - ay
    for (let x = box.x; x < box.x + box.w; x++) {
      const px = x + 0.5 - ax
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2))
      const ex = px - t * dx
      const ey = py - t * dy
      if (ex * ex + ey * ey <= r2) visit(y * width + x, x, y)
    }
  }
}

/** Pixels whose centre is inside the polygon (flat x0,y0,x1,y1,...; even-odd rule), clipped to the image. */
export function visitPolygon(width: number, height: number, points: readonly number[], visit: Visit): void {
  const n = Math.floor(points.length / 2)
  if (n < 3) return
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const y = points[i * 2 + 1] as number
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const top = Math.max(0, Math.floor(minY))
  const bottom = Math.min(height, Math.ceil(maxY))
  const cross: number[] = []
  for (let y = top; y < bottom; y++) {
    const cy = y + 0.5
    cross.length = 0
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const x0 = points[i * 2] as number
      const y0 = points[i * 2 + 1] as number
      const x1 = points[j * 2] as number
      const y1 = points[j * 2 + 1] as number
      if (y0 <= cy === y1 <= cy) continue
      cross.push(x0 + ((cy - y0) / (y1 - y0)) * (x1 - x0))
    }
    cross.sort((a, b) => a - b)
    for (let k = 0; k + 1 < cross.length; k += 2) {
      // pixel x is inside when its centre x + 0.5 lies in [left, right)
      const from = Math.max(0, Math.ceil((cross[k] as number) - 0.5))
      const to = Math.min(width, Math.ceil((cross[k + 1] as number) - 0.5))
      for (let x = from; x < to; x++) visit(y * width + x, x, y)
    }
  }
}

/**
 * Pixels set in a run-length mask over the rectangle (x, y, w, h): `runs`
 * alternates lengths of unset and set pixels, row by row, starting with unset.
 * This is how a detector's segmentation mask travels as JSON.
 */
export function visitMask(
  width: number,
  height: number,
  mask: { x: number; y: number; w: number; h: number; runs: readonly number[] },
  visit: Visit,
): void {
  let offset = 0
  let set = false
  const total = mask.w * mask.h
  for (const run of mask.runs) {
    const end = Math.min(total, offset + Math.max(0, Math.floor(run)))
    if (set) {
      for (let k = offset; k < end; k++) {
        const x = mask.x + (k % mask.w)
        const y = mask.y + Math.floor(k / mask.w)
        if (x >= 0 && y >= 0 && x < width && y < height) visit(y * width + x, x, y)
      }
    }
    offset = end
    set = !set
    if (offset >= total) break
  }
}
