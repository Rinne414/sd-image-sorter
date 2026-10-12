import { blurRect } from './effects'
import { ADJUST_KEYS, type AdjustValues, type BackgroundOp, type BaseOp } from './ops'
import { cloneRaster, visitMask, type Raster } from './raster'

// Picture edits over the whole image (the Adjust tab's filters and background
// removal), as pure pixel maths so the live preview, a replay and the saved
// copy give the same bytes. Order inside one adjustment: blur, sharpen, the
// colour changes (brightness, contrast, saturation, hue, temperature), vignette.

const LUMA = [0.2126, 0.7152, 0.0722] as const

/** The hue-rotate matrix (as CSS / SVG feColorMatrix define it), row by row. */
function hueMatrix(degrees: number): number[] {
  const rad = (degrees * Math.PI) / 180
  const a = Math.cos(rad)
  const b = Math.sin(rad)
  return [
    0.213 + a * 0.787 - b * 0.213,
    0.715 - a * 0.715 - b * 0.715,
    0.072 - a * 0.072 + b * 0.928,
    0.213 - a * 0.213 + b * 0.143,
    0.715 + a * 0.285 + b * 0.14,
    0.072 - a * 0.072 - b * 0.283,
    0.213 - a * 0.213 - b * 0.787,
    0.715 - a * 0.715 + b * 0.715,
    0.072 + a * 0.928 + b * 0.072,
  ]
}

/** One pixel's colour changes; returns the new r, g, b (not yet clamped). */
function colorOf(r: number, g: number, b: number, v: AdjustValues, hue: number[] | null): [number, number, number] {
  if (v.brightness) {
    const k = (100 + v.brightness) / 100
    r *= k
    g *= k
    b *= k
  }
  if (v.contrast) {
    const k = (100 + v.contrast) / 100
    r = (r - 128) * k + 128
    g = (g - 128) * k + 128
    b = (b - 128) * k + 128
  }
  if (v.saturation) {
    const k = (100 + v.saturation) / 100
    const l = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
    r = l + (r - l) * k
    g = l + (g - l) * k
    b = l + (b - l) * k
  }
  if (hue) {
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = hue as [number, number, number, number, number, number, number, number, number]
    ;[r, g, b] = [m0 * r + m1 * g + m2 * b, m3 * r + m4 * g + m5 * b, m6 * r + m7 * g + m8 * b]
  }
  if (v.temperature) {
    r += v.temperature
    b -= v.temperature
  }
  return [r, g, b]
}

function colorPass(raster: Raster, v: AdjustValues): void {
  if (!v.brightness && !v.contrast && !v.saturation && !(v.hue % 360) && !v.temperature) return
  const hue = v.hue % 360 ? hueMatrix(v.hue) : null
  const d = raster.data
  for (let p = 0; p < d.length; p += 4) {
    const [r, g, b] = colorOf(d[p] as number, d[p + 1] as number, d[p + 2] as number, v, hue)
    d[p] = r
    d[p + 1] = g
    d[p + 2] = b
  }
}

const whole = (raster: Raster) => ({ x: 0, y: 0, w: raster.width, h: raster.height })

/** Unsharp mask: each colour moves away from its 1-pixel blur by `amount` percent. */
function sharpenPass(raster: Raster, amount: number): void {
  const blurred = blurRect(raster, whole(raster), 1)
  const d = raster.data
  const k = amount / 100
  for (let p = 0; p < d.length; p += 4) {
    for (let c = 0; c < 3; c++) d[p + c] = (d[p + c] as number) + ((d[p + c] as number) - (blurred[p + c] as number)) * k
  }
}

/** Darker towards the corners: at `amount` 100 the corners keep 20% of their light. */
function vignettePass(raster: Raster, amount: number): void {
  const { width: w, height: h, data: d } = raster
  const k = (amount / 100) * 0.8
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5) / h - 0.5
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5) / w - 0.5
      const f = 1 - k * ((dx * dx + dy * dy) / 0.5)
      const p = (y * w + x) * 4
      d[p] = (d[p] as number) * f
      d[p + 1] = (d[p + 1] as number) * f
      d[p + 2] = (d[p + 2] as number) * f
    }
  }
}

/** The picture with the filters applied (a new raster; `source` is not changed). */
export function adjustRaster(source: Raster, v: AdjustValues): Raster {
  let out = cloneRaster(source)
  if (v.blur > 0) out = { width: out.width, height: out.height, data: blurRect(out, whole(out), v.blur) }
  if (v.sharpen > 0) sharpenPass(out, v.sharpen)
  colorPass(out, v)
  if (v.vignette > 0) vignettePass(out, v.vignette)
  return out
}

const FILL: Record<BackgroundOp['fill'], [number, number, number, number]> = {
  transparent: [0, 0, 0, 0],
  white: [255, 255, 255, 255],
  black: [0, 0, 0, 255],
}

/** Every pixel outside the foreground mask becomes the fill (a new raster). */
export function removeBackground(source: Raster, op: BackgroundOp): Raster {
  const out = cloneRaster(source)
  const keep = new Uint8Array(out.width * out.height)
  visitMask(out.width, out.height, op.mask, (i) => {
    keep[i] = 1
  })
  const fill = FILL[op.fill]
  for (let i = 0; i < keep.length; i++) if (!keep[i]) out.data.set(fill, i * 4)
  return out
}

/** The base picture: the original with every picture edit applied in order (the original itself when there is none). */
export function applyBaseOps(original: Raster, ops: readonly BaseOp[]): Raster {
  let out = original
  for (const op of ops) out = op.type === 'adjust' ? adjustRaster(out, op.values) : removeBackground(out, op)
  return out
}

/** True when the values change nothing. */
export function isNoAdjust(v: AdjustValues): boolean {
  return ADJUST_KEYS.every((k) => (k === 'hue' ? v.hue % 360 === 0 : v[k] === 0))
}
