import { describe, expect, it } from 'vitest'
import { paletteOf } from './palette'

/** RGBA pixels: `n` of each colour in turn. */
function pixels(...runs: [number, [number, number, number, number?]][]): Uint8ClampedArray {
  const out: number[] = []
  for (const [n, [r, g, b, a = 255]] of runs) for (let i = 0; i < n; i++) out.push(r, g, b, a)
  return new Uint8ClampedArray(out)
}

describe('main colours measured from pixels (a dropped file has no stored analysis)', () => {
  it('finds each flat colour with its share, largest first', () => {
    expect(paletteOf(pixels([30, [0, 0, 255]], [60, [255, 0, 0]], [10, [0, 128, 0]]))).toEqual([
      { hex: '#FF0000', pct: 60 },
      { hex: '#0000FF', pct: 30 },
      { hex: '#008000', pct: 10 },
    ])
  })

  it('keeps the five largest of at most eight, as the library analysis does', () => {
    const runs: [number, [number, number, number]][] = Array.from({ length: 12 }, (_, i) => [12 - i, [i * 20, 255 - i * 20, (i * 70) % 256]])
    const found = paletteOf(pixels(...runs))
    expect(found).toHaveLength(5)
    expect(found.map((s) => s.pct)).toEqual([...found.map((s) => s.pct)].sort((a, b) => b - a))
    expect(found.every((s) => /^#[0-9A-F]{6}$/.test(s.hex))).toBe(true)
  })

  it('leaves out see-through pixels, and has nothing to say about an empty picture', () => {
    expect(paletteOf(pixels([10, [255, 255, 255]], [90, [0, 0, 0, 0]]))).toEqual([{ hex: '#FFFFFF', pct: 100 }])
    expect(paletteOf(new Uint8ClampedArray())).toEqual([])
  })
})
