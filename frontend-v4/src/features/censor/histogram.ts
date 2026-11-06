import { hsvPalette, type PaletteColor } from '../../lib/hsvPalette'
import type { Raster } from './raster'

// The Adjust tab's histogram and main colours, from a sample of the picture
// (about SAMPLES pixels, spread evenly).

const SAMPLES = 96 * 96

export interface ColorStats {
  /** 256 bins per channel. */
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
  /** The main colours, largest first: '#rrggbb' and the share of the sample (0-1). */
  colors: PaletteColor[]
}

export function colorStats(raster: Raster, top = 6): ColorStats {
  const r = new Uint32Array(256)
  const g = new Uint32Array(256)
  const b = new Uint32Array(256)
  const pixels = raster.width * raster.height
  const step = Math.max(1, Math.floor(pixels / SAMPLES))
  const sample: number[] = []
  for (let i = 0; i < pixels; i += step) {
    const p = i * 4
    if ((raster.data[p + 3] as number) === 0) continue
    const cr = raster.data[p] as number
    const cg = raster.data[p + 1] as number
    const cb = raster.data[p + 2] as number
    r[cr] = (r[cr] as number) + 1
    g[cg] = (g[cg] as number) + 1
    b[cb] = (b[cb] as number) + 1
    sample.push(cr, cg, cb, 255)
  }
  return { r, g, b, colors: hsvPalette(sample, top) }
}

/** An SVG area path for one channel's bins, `w` x `h`, scaled to the tallest bin (the extremes 0 and 255 left out of the scale). */
export function histogramPath(bins: Uint32Array, peak: number, w: number, h: number): string {
  const top = Math.max(1, peak)
  let d = `M0 ${h}`
  for (let i = 0; i < 256; i++) d += ` L${((i + 0.5) * w) / 256} ${h - Math.min(h, ((bins[i] as number) / top) * h * 0.9)}`
  return `${d} L${w} ${h} Z`
}

export function histogramPeak(stats: ColorStats): number {
  let peak = 1
  for (let i = 1; i < 255; i++) peak = Math.max(peak, stats.r[i] as number, stats.g[i] as number, stats.b[i] as number)
  return peak
}
