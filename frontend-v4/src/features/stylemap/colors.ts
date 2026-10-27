import type { ColorsAnswer, LegendEntry } from './types'

// Dot colours: every dot takes the value of the field the user picked
// (GET /api/style-map/colors, ids and values in point order). This turns one
// answer into the per-dot RGB the scene paints from and decides how many
// legend chips fit on the row.
//
// Data colours (docs/DESIGN_VOPUS.md §color-exemptions "Style Map dots"),
// the same as the classic page: twelve category hues that stay clear of pure
// blue, purple, pink and the amber accent; a viridis ramp for scores; one
// neutral grey for "no data". They go to the shader as they are, so a legend
// swatch and its dots are the same colour on screen.

export const CATEGORY_HEX = [
  '#D8524B', '#E8927C', '#A9A331', '#7FB83C', '#36A853', '#1E7F55',
  '#5FC9A6', '#239E9A', '#3BA7D1', '#1F6F8E', '#8B5E3C', '#E0C84D',
] as const
export const OTHER_HEX = '#9A9A94'
export const NO_DATA_HEX = '#5A5A60'
export const RAMP_HEX = ['#443983', '#21918C', '#FDE725'] as const
/** The legend entry that folds every small category together. */
export const OTHER_KEY = '__other__'

export type Rgb = [number, number, number]

/** '#RRGGBB' -> [r, g, b] in 0..1 (no colour-space conversion). */
export function hexToRgb(hex: string): Rgb {
  const value = parseInt(hex.replace('#', ''), 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

export const NO_DATA_RGB = hexToRgb(NO_DATA_HEX)
const RAMP_RGB = RAMP_HEX.map(hexToRgb)
const CATEGORY_RGB = CATEGORY_HEX.map(hexToRgb)
const OTHER_RGB = hexToRgb(OTHER_HEX)

/** The colour at t in 0..1 along the three-stop ramp. */
export function rampColor(t: number): Rgb {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0))
  const scaled = clamped * (RAMP_RGB.length - 1)
  const low = Math.min(RAMP_RGB.length - 2, Math.floor(scaled))
  const mix = scaled - low
  const a = RAMP_RGB[low]!
  const b = RAMP_RGB[low + 1]!
  return [a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix]
}

/** The swatch colour of legend entry `index` (the folded "other" entry is grey). */
export function legendHex(entry: Pick<LegendEntry, 'key'>, index: number): string {
  if (entry.key === OTHER_KEY) return OTHER_HEX
  return CATEGORY_HEX[index % CATEGORY_HEX.length]!
}

function legendRgb(entry: Pick<LegendEntry, 'key'>, index: number): Rgb {
  if (entry.key === OTHER_KEY) return OTHER_RGB
  return CATEGORY_RGB[index % CATEGORY_RGB.length]!
}

/** No-data grey for `count` dots. */
export function greyColors(count: number): Float32Array {
  const rgb = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) rgb.set(NO_DATA_RGB, i * 3)
  return rgb
}

/**
 * Per-dot RGB (3 floats per dot, in the scene's point order) for one colours
 * answer. Dots the answer does not cover, and values that are null, keep the
 * no-data grey. Linear in the number of dots.
 */
export function buildPointColors(body: ColorsAnswer | null, sceneIds: ArrayLike<number>): Float32Array {
  const count = sceneIds.length
  const rgb = greyColors(count)
  if (!body || body.status !== 'ok' || !Array.isArray(body.ids) || !Array.isArray(body.values)) return rgb
  const index = new Map<number, number>()
  for (let i = 0; i < count; i += 1) index.set(sceneIds[i]!, i)
  const isScale = body.kind === 'scale'
  const [low, high] = Array.isArray(body.range) ? body.range : [0, 0]
  const span = high - low
  const palette = isScale ? [] : (body.legend ?? []).map(legendRgb)
  const { ids, values } = body
  for (let i = 0; i < ids.length; i += 1) {
    const value = values[i]
    if (value === null || value === undefined) continue
    const at = index.get(ids[i]!)
    if (at === undefined) continue
    const color = isScale ? rampColor(span > 0 ? (value - low) / span : 0.5) : palette[value]
    if (!color) continue
    rgb.set(color, at * 3)
  }
  return rgb
}

/** A score as the legend writes it (two decimals). */
export const formatScore = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : '')

/** The CSS gradient of the score ramp. */
export const RAMP_CSS = `linear-gradient(90deg, ${RAMP_HEX.join(', ')})`

/**
 * How many legend chips fit in a row `width` px wide: all of them, else as
 * many as fit beside the "+N" button (gap included), never fewer than one
 * when one squeezed chip of `minChip` px still fits (it ellipsizes).
 * `squeeze` is the width that one chip then gets, else null.
 */
export function foldChips(widths: readonly number[], width: number, button: number, gap: number, minChip: number): { shown: number; squeeze: number | null } {
  const row = (count: number) => widths.slice(0, count).reduce((sum, w, i) => sum + w + (i ? gap : 0), 0)
  if (row(widths.length) <= width) return { shown: widths.length, squeeze: null }
  let shown = 0
  while (shown < widths.length && row(shown + 1) + gap + button <= width) shown += 1
  if (shown === 0) {
    const squeezed = width - gap - button
    if (squeezed >= minChip && widths.length > 0) return { shown: 1, squeeze: squeezed }
  }
  return { shown, squeeze: null }
}
