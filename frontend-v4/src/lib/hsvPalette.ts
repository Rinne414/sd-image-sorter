// The program's one way to find a picture's main colours, in HSV. Keep in step
// with backend/hsv_palette.py (the reasons and measurements are there) and
// frontend/js/modules/utils/hsv-palette.js: all three give the answers in
// backend/tests/fixtures/hsv_palette_vectors.json.

export interface PaletteColor {
  /** '#rrggbb' */
  hex: string
  /** Share of the picture, 0-1. */
  share: number
}

interface Bin {
  chromatic: boolean
  count: number
  hue: number
  saturation: number
  value: number
}

const BLACK_VALUE = 0.14
const GRAY_SATURATION = 0.1
const HUE_BIN_DEGREES = 12
const SATURATION_EDGES = [0.35, 0.65]
const VALUE_EDGES = [0.4, 0.7]
const GRAY_VALUE_EDGES = [0.4, 0.7, 0.85]
const MERGE_HUE_DEGREES = 20
const MERGE_SATURATION = 0.35
const MERGE_VALUE = 0.3
const MERGE_GRAY_VALUE = 0.2
const MIN_SHARE_PERCENT = 1
const RADIANS = Math.PI / 180

function band(value: number, edges: number[]): number {
  const index = edges.findIndex((edge) => value < edge)
  return index === -1 ? edges.length : index
}

function toHsv(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const high = Math.max(red, green, blue)
  const spread = high - Math.min(red, green, blue)
  if (spread === 0) return [0, 0, high]
  let sector: number
  if (high === red) sector = ((green - blue) / spread + 6) % 6
  else if (high === green) sector = (blue - red) / spread + 2
  else sector = (red - green) / spread + 4
  return [sector * 60, spread / high, high]
}

function toHex(hue: number, saturation: number, value: number): string {
  const chroma = value * saturation
  const sector = hue / 60
  const second = chroma * (1 - Math.abs((sector % 2) - 1))
  const base = value - chroma
  const sectors: [number, number, number][] = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ]
  const parts = sectors[Math.floor(sector) % 6] as [number, number, number]
  return `#${parts.map((part) => Math.floor((part + base) * 255 + 0.5).toString(16).padStart(2, '0')).join('')}`
}

function binKey(hue: number, saturation: number, value: number): string {
  if (value < BLACK_VALUE) return 'k'
  if (saturation < GRAY_SATURATION) return `g${band(value, GRAY_VALUE_EDGES)}`
  const hueBin = Math.floor(hue / HUE_BIN_DEGREES) % 30
  return `c${hueBin}.${band(saturation, SATURATION_EDGES)}.${band(value, VALUE_EDGES)}`
}

function collectBins(rgba: ArrayLike<number>): { bins: Bin[]; total: number } {
  const entries = new Map<string, { count: number; sines: number; cosines: number; saturations: number; values: number }>()
  let total = 0
  for (let offset = 0; offset + 3 < rgba.length; offset += 4) {
    if (rgba[offset + 3] === 0) continue
    total += 1
    const [hue, saturation, value] = toHsv(rgba[offset] as number, rgba[offset + 1] as number, rgba[offset + 2] as number)
    const key = binKey(hue, saturation, value)
    const entry = entries.get(key) ?? { count: 0, sines: 0, cosines: 0, saturations: 0, values: 0 }
    const angle = hue * RADIANS
    entries.set(key, {
      count: entry.count + 1,
      sines: entry.sines + Math.sin(angle),
      cosines: entry.cosines + Math.cos(angle),
      saturations: entry.saturations + saturation,
      values: entry.values + value,
    })
  }
  const bins = [...entries].map(([key, entry]) => ({
    chromatic: key[0] === 'c',
    count: entry.count,
    hue: (((Math.atan2(entry.sines / entry.count, entry.cosines / entry.count) / RADIANS) % 360) + 360) % 360,
    saturation: entry.saturations / entry.count,
    value: entry.values / entry.count,
  }))
  bins.sort((a, b) => b.count - a.count)
  return { bins, total }
}

function sameColour(seed: Bin, other: Bin): boolean {
  if (seed.chromatic !== other.chromatic) return false
  if (!seed.chromatic) return Math.abs(seed.value - other.value) <= MERGE_GRAY_VALUE
  const gap = Math.abs(seed.hue - other.hue) % 360
  return (
    Math.min(gap, 360 - gap) <= MERGE_HUE_DEGREES &&
    Math.abs(seed.saturation - other.saturation) <= MERGE_SATURATION &&
    Math.abs(seed.value - other.value) <= MERGE_VALUE
  )
}

/** The main colours of RGBA pixels, largest share first; fully transparent pixels are not part of the picture. */
export function hsvPalette(rgba: ArrayLike<number>, top = 5): PaletteColor[] {
  const { bins, total } = collectBins(rgba)
  if (total === 0) return []
  const used = new Set<number>()
  const groups: { count: number; seed: Bin }[] = []
  bins.forEach((seed, index) => {
    if (used.has(index)) return
    used.add(index)
    let count = seed.count
    for (let other = index + 1; other < bins.length; other += 1) {
      const candidate = bins[other] as Bin
      if (!used.has(other) && sameColour(seed, candidate)) {
        used.add(other)
        count += candidate.count
      }
    }
    groups.push({ count, seed })
  })
  groups.sort((a, b) => b.count - a.count)
  const largeEnough = groups.filter((group) => (group.count / total) * 100 >= MIN_SHARE_PERCENT)
  return (largeEnough.length ? largeEnough : groups.slice(0, 1))
    .slice(0, top)
    .map(({ count, seed }) => ({ hex: toHex(seed.hue, seed.saturation, seed.value), share: count / total }))
}
