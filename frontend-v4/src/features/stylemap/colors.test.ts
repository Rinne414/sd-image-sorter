import { describe, expect, it } from 'vitest'
import { buildPointColors, CATEGORY_HEX, foldChips, hexToRgb, legendHex, NO_DATA_RGB, OTHER_HEX, OTHER_KEY, rampColor, RAMP_HEX } from './colors'

const close = (actual: ArrayLike<number>, expected: ArrayLike<number>) => {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i += 1) expect(actual[i]).toBeCloseTo(expected[i]!, 5)
}

describe('style map colours', () => {
  it('reads hex as 0..1 channels', () => {
    close(hexToRgb('#FF8000'), [1, 128 / 255, 0])
  })

  it('walks the score ramp from its first to its last stop, clamping outside 0..1', () => {
    close(rampColor(0), hexToRgb(RAMP_HEX[0]))
    close(rampColor(1), hexToRgb(RAMP_HEX[2]))
    close(rampColor(0.5), hexToRgb(RAMP_HEX[1]))
    close(rampColor(-3), hexToRgb(RAMP_HEX[0]))
    close(rampColor(Number.NaN), hexToRgb(RAMP_HEX[0]))
  })

  it('gives the folded "other" entry grey and the rest the category hues in turn', () => {
    expect(legendHex({ key: OTHER_KEY }, 0)).toBe(OTHER_HEX)
    expect(legendHex({ key: 'nai' }, 1)).toBe(CATEGORY_HEX[1])
    expect(legendHex({ key: 'x' }, 12)).toBe(CATEGORY_HEX[0])
  })

  it('colours categories by legend index in the scene order; unknown ids and nulls stay grey', () => {
    const rgb = buildPointColors(
      { status: 'ok', kind: 'category', ids: [30, 10, 99], values: [1, null, 0], legend: [{ key: 'a', count: 1 }, { key: 'b', count: 1 }] },
      [10, 20, 30],
    )
    close(rgb.slice(0, 3), NO_DATA_RGB) // id 10: null
    close(rgb.slice(3, 6), NO_DATA_RGB) // id 20: not in the answer
    close(rgb.slice(6, 9), hexToRgb(CATEGORY_HEX[1])) // id 30: category 1
  })

  it('colours scores along the range; a flat range sits in the middle of the ramp', () => {
    const rgb = buildPointColors({ status: 'ok', kind: 'scale', ids: [1, 2], values: [3, 8], range: [3, 8] }, [1, 2])
    close(rgb.slice(0, 3), rampColor(0))
    close(rgb.slice(3, 6), rampColor(1))
    const flat = buildPointColors({ status: 'ok', kind: 'scale', ids: [1], values: [5], range: [5, 5] }, [1])
    close(flat, rampColor(0.5))
  })

  it('leaves every dot grey for a failed or missing answer', () => {
    close(buildPointColors(null, [1, 2]), [...NO_DATA_RGB, ...NO_DATA_RGB])
    close(buildPointColors({ status: 'not_started' }, [1]), NO_DATA_RGB)
  })

  it('handles thirty thousand dots in one linear pass', () => {
    const count = 30_000
    const ids = Array.from({ length: count }, (_, i) => i + 1)
    const values = ids.map((_, i) => i % 12)
    const legend = Array.from({ length: 12 }, (_, i) => ({ key: `g${i}`, count: count / 12 }))
    const started = performance.now()
    const rgb = buildPointColors({ status: 'ok', kind: 'category', ids, values, legend }, ids)
    expect(rgb.length).toBe(count * 3)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('legend folding', () => {
  it('shows every chip when they fit', () => {
    expect(foldChips([50, 50], 120, 40, 6, 72)).toEqual({ shown: 2, squeeze: null })
  })

  it('shows as many chips as fit beside the "+N" button', () => {
    // 50 + 6 + 50 = 106; + 6 + 40 = 152 <= 160; a third would need 208.
    expect(foldChips([50, 50, 50, 50], 160, 40, 6, 72)).toEqual({ shown: 2, squeeze: null })
  })

  it('squeezes the first chip rather than leave "+N" alone, when a squeezed chip is still readable', () => {
    expect(foldChips([300, 50], 200, 40, 6, 72)).toEqual({ shown: 1, squeeze: 154 })
    expect(foldChips([300, 50], 100, 40, 6, 72)).toEqual({ shown: 0, squeeze: null })
  })
})
