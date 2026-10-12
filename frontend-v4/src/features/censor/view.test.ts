import { describe, expect, it } from 'vitest'
import { fitView, toImage, zoomAt, ZOOM_MAX } from './view'

describe('canvas view', () => {
  it('fits the whole image, centred, and enlarges small ones', () => {
    const v = fitView(832, 632, 1600, 1200)
    expect(v.z).toBeCloseTo(0.5)
    expect(v.tx).toBeCloseTo(16)
    expect(v.ty).toBeCloseTo(16)
    expect(fitView(1000, 1000, 64, 64).z).toBeGreaterThan(10)
  })

  it('zooms around the pointer: the pixel under it stays under it', () => {
    const v = { z: 0.5, tx: 16, ty: 16 }
    const before = toImage(v, 300, 200)
    const after = zoomAt(v, 2, 300, 200)
    expect(after.z).toBe(1)
    const [x, y] = toImage(after, 300, 200)
    expect(x).toBeCloseTo(before[0])
    expect(y).toBeCloseTo(before[1])
  })

  it('stops at the zoom limits', () => {
    expect(zoomAt({ z: 30, tx: 0, ty: 0 }, 4, 0, 0).z).toBe(ZOOM_MAX)
  })
})
