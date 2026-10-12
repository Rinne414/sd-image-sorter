import { useEffect, useState } from 'react'
import { createRaster, type Raster } from './raster'

// Big pictures (FAST_PREVIEW_PIXELS and up): while a filter slider moves, the
// editor shows the filter on a small copy (about FAST_PREVIEW_TARGET pixels)
// laid over the picture; once the slider rests for SETTLE_MS the full-size
// preview is rendered as usual. Applying and saving always use full size.

export const FAST_PREVIEW_PIXELS = 25_000_000
export const FAST_PREVIEW_TARGET = 4_000_000
export const SETTLE_MS = 400

/** Above this the editor warns that editing may be slow and memory-hungry (owner rule: warn, never block). */
export const LARGE_PICTURE_PIXELS = 40_000_000
/** Peak memory of the editor tab per megapixel, measured with the binary save (shots/large-image/report.json: about 40). */
const MB_PER_MEGAPIXEL = 45

export function memoryEstimateGb(pixels: number): number {
  return Math.round(((pixels / 1e6) * MB_PER_MEGAPIXEL) / 100) / 10
}

/** A copy of about `target` pixels (nearest pixel; the copy is only looked at, never saved). */
export function downscale(source: Raster, target: number): Raster {
  const k = Math.min(1, Math.sqrt(target / (source.width * source.height)))
  const w = Math.max(1, Math.round(source.width * k))
  const h = Math.max(1, Math.round(source.height * k))
  const out = createRaster(w, h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(source.height - 1, Math.floor(((y + 0.5) * source.height) / h))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(source.width - 1, Math.floor(((x + 0.5) * source.width) / w))
      const s = (sy * source.width + sx) * 4
      out.data.set(source.data.subarray(s, s + 4), (y * w + x) * 4)
    }
  }
  return out
}

/** `value` once it has not changed for `ms` (at once when `ms` is 0). */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (ms <= 0) return setSettled(value)
    const timer = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return ms <= 0 ? value : settled
}
