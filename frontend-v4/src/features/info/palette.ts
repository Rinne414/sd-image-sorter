// The main colours of a picture measured in the browser (a file brought into
// the Reader has no stored analysis): the same idea as the library's analysis
// (color_analyzer.py: median cut to 8 colours on a 64 px copy, the 5 largest
// with their share), so the swatches read alike.

export interface Swatch {
  hex: string
  /** Share of the picture, 0–100, one decimal. */
  pct: number
}

export const PALETTE_SAMPLE = 64
const COLORS = 8
const TOP = 5

/** A distinct colour and how many pixels have it: [r, g, b, count]. */
type Entry = [number, number, number, number]
type Box = Entry[]

const pixelsIn = (box: Box) => box.reduce((sum, e) => sum + e[3], 0)

/** The channel (0 r, 1 g, 2 b) along which the box's colours spread most. */
function widest(box: Box): number {
  let best = 0
  let spread = -1
  for (let c = 0; c < 3; c++) {
    const values = box.map((e) => e[c] as number)
    const range = Math.max(...values) - Math.min(...values)
    if (range > spread) [best, spread] = [c, range]
  }
  return best
}

/** Cut a box at the pixel median along its widest channel; a colour never lands in both halves. */
function cut(box: Box): [Box, Box] {
  const channel = widest(box)
  const sorted = [...box].sort((a, b) => (a[channel] as number) - (b[channel] as number))
  const half = pixelsIn(sorted) / 2
  let sum = 0
  let at = 1
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i]?.[3] ?? 0
    if (sum >= half) {
      at = i + 1
      break
    }
  }
  at = Math.min(Math.max(at, 1), sorted.length - 1)
  return [sorted.slice(0, at), sorted.slice(at)]
}

/** Split the box with the most pixels (and more than one colour) until there are `n`. */
function medianCut(entries: Box, n: number): Box[] {
  const boxes: Box[] = [entries]
  while (boxes.length < n) {
    let pick = -1
    boxes.forEach((box, i) => {
      if (box.length > 1 && (pick < 0 || pixelsIn(box) > pixelsIn(boxes[pick] as Box))) pick = i
    })
    if (pick < 0) break
    boxes.splice(pick, 1, ...cut(boxes[pick] as Box))
  }
  return boxes
}

const hex2 = (v: number) => Math.round(v).toString(16).toUpperCase().padStart(2, '0')

/** The largest colours of RGBA pixels; fully see-through pixels are left out. */
export function paletteOf(rgba: Uint8ClampedArray): Swatch[] {
  const counts = new Map<number, number>()
  let total = 0
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    const rgb = ((rgba[i] as number) << 16) | ((rgba[i + 1] as number) << 8) | (rgba[i + 2] as number)
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1)
    total += 1
  }
  if (total === 0) return []
  const entries: Box = [...counts].map(([rgb, n]) => [rgb >> 16, (rgb >> 8) & 255, rgb & 255, n])
  const merged = new Map<string, number>()
  for (const box of medianCut(entries, COLORS)) {
    const n = pixelsIn(box)
    const mean = [0, 1, 2].map((c) => box.reduce((sum, e) => sum + (e[c] as number) * e[3], 0) / n)
    const hex = `#${mean.map(hex2).join('')}`
    merged.set(hex, (merged.get(hex) ?? 0) + n)
  }
  return [...merged]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([hex, n]) => ({ hex, pct: Math.round((n / total) * 1000) / 10 }))
}
