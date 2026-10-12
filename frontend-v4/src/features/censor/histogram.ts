import type { Raster } from './raster'

// The Adjust tab's histogram and main colours, from a sample of the picture
// (about SAMPLES pixels, spread evenly), as V3.5 measured them: colours are
// grouped in steps of 32 and each group shows its average.

const SAMPLES = 96 * 96
const GROUP = 32

export interface ColorStats {
  /** 256 bins per channel. */
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
  /** The most common colour groups, most common first: '#rrggbb' and the share of the sample (0-1). */
  colors: { hex: string; share: number }[]
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

export function colorStats(raster: Raster, top = 6): ColorStats {
  const r = new Uint32Array(256)
  const g = new Uint32Array(256)
  const b = new Uint32Array(256)
  const groups = new Map<number, { n: number; r: number; g: number; b: number }>()
  const pixels = raster.width * raster.height
  const step = Math.max(1, Math.floor(pixels / SAMPLES))
  let n = 0
  for (let i = 0; i < pixels; i += step) {
    const p = i * 4
    if ((raster.data[p + 3] as number) === 0) continue
    const cr = raster.data[p] as number
    const cg = raster.data[p + 1] as number
    const cb = raster.data[p + 2] as number
    r[cr] = (r[cr] as number) + 1
    g[cg] = (g[cg] as number) + 1
    b[cb] = (b[cb] as number) + 1
    const key = (Math.round(cr / GROUP) << 16) | (Math.round(cg / GROUP) << 8) | Math.round(cb / GROUP)
    const group = groups.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    groups.set(key, { n: group.n + 1, r: group.r + cr, g: group.g + cg, b: group.b + cb })
    n++
  }
  const colors = [...groups.values()]
    .sort((x, y) => y.n - x.n)
    .slice(0, top)
    .map((c) => ({ hex: hex(c.r / c.n, c.g / c.n, c.b / c.n), share: n ? c.n / n : 0 }))
  return { r, g, b, colors }
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
