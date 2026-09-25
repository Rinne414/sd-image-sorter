import type { Raster, Rect } from './raster'

// What an edit does to the pixels it covers. Integer maths only, so the same
// edit on the same pixels always gives the same bytes (live painting, replay
// after undo and the saved copy agree exactly).

export type Effect =
  /** Each grid cell (block x block, aligned to the image corner) becomes its average colour. */
  | { kind: 'mosaic'; block: number }
  /** A 3-pass box blur of the given radius (close to a Gaussian). */
  | { kind: 'blur'; radius: number }
  /** Paint a solid colour over the pixel with `alpha` 0-1. */
  | { kind: 'fill'; r: number; g: number; b: number; alpha: number }
  /** Put the original pixel back. */
  | { kind: 'restore' }
  /** Copy the original pixel (dx, dy) away (clone stamp); pixels whose source is outside the picture stay. */
  | { kind: 'clone'; dx: number; dy: number }

/** Paint colour (r, g, b) with opacity `alpha` over pixel `p` (byte offset), source-over. */
export function blendPixel(data: Uint8ClampedArray, p: number, r: number, g: number, b: number, alpha: number): void {
  if (alpha >= 1) {
    data[p] = r
    data[p + 1] = g
    data[p + 2] = b
    data[p + 3] = 255
    return
  }
  const under = (data[p + 3] as number) / 255
  const keep = under * (1 - alpha)
  const out = alpha + keep
  if (out <= 0) return
  data[p] = Math.round((r * alpha + (data[p] as number) * keep) / out)
  data[p + 1] = Math.round((g * alpha + (data[p + 1] as number) * keep) / out)
  data[p + 2] = Math.round((b * alpha + (data[p + 2] as number) * keep) / out)
  data[p + 3] = Math.round(out * 255)
}

/** Replace mosaic cell (cx, cy) with the average of its pixels (the cell is clipped to the image). */
export function mosaicCell(target: Raster, cx: number, cy: number, block: number): Rect {
  const x0 = cx * block
  const y0 = cy * block
  const x1 = Math.min(target.width, x0 + block)
  const y1 = Math.min(target.height, y0 + block)
  const d = target.data
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  for (let y = y0; y < y1; y++) {
    for (let p = (y * target.width + x0) * 4, end = (y * target.width + x1) * 4; p < end; p += 4) {
      r += d[p] as number
      g += d[p + 1] as number
      b += d[p + 2] as number
      a += d[p + 3] as number
    }
  }
  const n = (x1 - x0) * (y1 - y0)
  const half = n >> 1
  r = Math.floor((r + half) / n)
  g = Math.floor((g + half) / n)
  b = Math.floor((b + half) / n)
  a = Math.floor((a + half) / n)
  for (let y = y0; y < y1; y++) {
    for (let p = (y * target.width + x0) * 4, end = (y * target.width + x1) * 4; p < end; p += 4) {
      d[p] = r
      d[p + 1] = g
      d[p + 2] = b
      d[p + 3] = a
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** One box pass along x or y; samples past the rectangle's edge repeat the edge pixel. */
function boxPass(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, radius: number, alongX: boolean): void {
  const n = 2 * radius + 1
  const half = n >> 1
  const lines = alongX ? h : w
  const len = alongX ? w : h
  const step = alongX ? 4 : w * 4
  const last = len - 1
  for (let line = 0; line < lines; line++) {
    const start = alongX ? line * w * 4 : line * 4
    for (let c = 0; c < 4; c++) {
      const at = (k: number) => src[start + (k < 0 ? 0 : k > last ? last : k) * step + c] as number
      let sum = 0
      for (let k = -radius; k <= radius; k++) sum += at(k)
      for (let i = 0; i < len; i++) {
        dst[start + i * step + c] = Math.floor((sum + half) / n)
        sum += at(i + radius + 1) - at(i - radius)
      }
    }
  }
}

/**
 * The blurred pixels of `rect` of `source` (w x h x 4 bytes). A pixel's value
 * only depends on source pixels within 3 x radius, so a rectangle with that
 * margin gives exact values for everything inside the margin.
 */
export function blurRect(source: Raster, rect: Rect, radius: number): Uint8ClampedArray<ArrayBuffer> {
  const { x, y, w, h } = rect
  const a = new Uint8ClampedArray(w * h * 4)
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * source.width + x) * 4
    a.set(source.data.subarray(from, from + w * 4), row * w * 4)
  }
  const b = new Uint8ClampedArray(a.length)
  for (let pass = 0; pass < 3; pass++) {
    boxPass(a, b, w, h, radius, true)
    boxPass(b, a, w, h, radius, false)
  }
  return a
}

/** The margin `blurRect` needs around the pixels it must get exactly right. */
export function blurMargin(radius: number): number {
  return 3 * radius
}

/** '#rrggbb' to [r, g, b]; anything else is black. */
export function parseHex(color: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(color)
  if (!m) return [0, 0, 0]
  const v = Number.parseInt(m[1] as string, 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}
