import { describe, expect, it } from 'vitest'
import recorded from '../../../backend/tests/fixtures/hsv_palette_vectors.json'
import { hsvPalette } from './hsvPalette'

interface Vector {
  name: string
  top: number
  pixels: [[number, number, number], number][]
  expected: { hex: string; pct: number }[]
}

const vectors = recorded as unknown as Vector[]

describe('hsvPalette gives the answers recorded for all three copies', () => {
  it.each(vectors)('$name', ({ pixels, top, expected }) => {
    const rgba: number[] = []
    for (const [[r, g, b], count] of pixels) {
      for (let i = 0; i < count; i += 1) rgba.push(r, g, b, 255)
    }
    rgba.push(9, 200, 9, 0)
    const answer = hsvPalette(rgba, top).map(({ hex, share }) => ({ hex, pct: Math.round(share * 1000) / 10 }))
    expect(answer).toEqual(expected.map(({ hex, pct }) => ({ hex: hex.toLowerCase(), pct })))
  })
})
