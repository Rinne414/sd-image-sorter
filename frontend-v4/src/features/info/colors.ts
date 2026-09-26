import type { Raster } from '../censor/raster'

// One image's colours for the card: a histogram measured from its thumbnail
// in the browser (RGB, per channel or luma, as V3.5 drew it), and the stored
// colour analysis (main colours, brightness, saturation, tone) that the
// colour filters and sorts use. Pure: ColorSection.tsx reads the pixels.

export type HistMode = 'rgb' | 'split' | 'luma'

export interface Bins {
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
  /** Luma (Rec. 601), 0-255. */
  l: Uint32Array
}

export function channelBins(raster: Raster): Bins {
  const bins: Bins = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) }
  const { data } = raster
  for (let p = 0; p < data.length; p += 4) {
    if ((data[p + 3] as number) === 0) continue
    const r = data[p] as number
    const g = data[p + 1] as number
    const b = data[p + 2] as number
    bins.r[r] = (bins.r[r] as number) + 1
    bins.g[g] = (bins.g[g] as number) + 1
    bins.b[b] = (bins.b[b] as number) + 1
    const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
    bins.l[l] = (bins.l[l] as number) + 1
  }
  return bins
}

/** The tallest bin the view scales to; pure black and white are left out so a flat backdrop does not flatten the rest. */
export function binsPeak(bins: Bins, mode: HistMode): number {
  const channels = mode === 'luma' ? [bins.l] : [bins.r, bins.g, bins.b]
  let peak = 1
  for (const c of channels) for (let i = 1; i < 255; i++) peak = Math.max(peak, c[i] as number)
  return peak
}

/** An SVG polyline through one channel's bins inside the band [top, top + h) of a `w` wide view. */
export function histogramLine(bins: Uint32Array, peak: number, w: number, top: number, h: number): string {
  let d = ''
  for (let i = 0; i < 256; i++) {
    const x = ((i + 0.5) * w) / 256
    const y = top + h - Math.min(h, ((bins[i] as number) / Math.max(1, peak)) * h * 0.9)
    d += `${i ? ' L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`
  }
  return d
}

export interface ColorFacts {
  /** The main colours, most of the picture first: '#RRGGBB' and percent. */
  colors: { hex: string; pct: number }[]
  /** 0-100. */
  brightness: number | null
  saturation: number | null
  temperature: 'warm' | 'cool' | 'neutral' | null
  distribution: 'left_heavy' | 'right_heavy' | 'edge_heavy' | 'middle_heavy' | 'balanced' | null
}

const TEMPERATURES = new Set(['warm', 'cool', 'neutral'])
const DISTRIBUTIONS = new Set(['left_heavy', 'right_heavy', 'edge_heavy', 'middle_heavy', 'balanced'])
const percent = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round((v / 255) * 100) : null)

function mainColors(raw: string | null | undefined): ColorFacts['colors'] {
  if (!raw) return []
  try {
    const list: unknown = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list.flatMap((c: { hex?: unknown; pct?: unknown }) =>
      typeof c?.hex === 'string' && /^#[0-9a-f]{6}$/i.test(c.hex) ? [{ hex: c.hex.toUpperCase(), pct: typeof c.pct === 'number' ? c.pct : 0 }] : [],
    )
  } catch {
    return []
  }
}

/** The stored colour analysis, or null when the image has not been analysed. */
export function readColorFacts(image: {
  dominant_colors?: string | null
  avg_brightness?: number | null
  color_saturation?: number | null
  color_temperature?: string | null
  brightness_distribution?: string | null
}): ColorFacts | null {
  if (typeof image.avg_brightness !== 'number') return null
  const temperature = TEMPERATURES.has(image.color_temperature ?? '') ? (image.color_temperature as ColorFacts['temperature']) : null
  const distribution = DISTRIBUTIONS.has(image.brightness_distribution ?? '') ? (image.brightness_distribution as ColorFacts['distribution']) : null
  return {
    colors: mainColors(image.dominant_colors),
    brightness: percent(image.avg_brightness),
    saturation: percent(image.color_saturation),
    temperature,
    distribution,
  }
}
