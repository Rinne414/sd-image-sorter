import { describe, expect, it } from 'vitest'
import { assignRegions, basePointSize, cloudArrays, coreBox, dotsInPolygon, dotsInRect, floorGrid, GRID_PAD, indexOfId, insidePolygon, MAX_POINT_SIZE, MIN_POINT_SIZE, nearestDot, projectPoints } from './geometry'

/** A column-major orthographic-like matrix: u = (x + 1) / 2, v = (1 - y) / 2, w = 1. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

describe('the cloud arrays', () => {
  it('reads the rows by their named columns', () => {
    const cloud = cloudArrays([[7, 0.1, 0.2, 0.3, 3]], ['id', 'x', 'y', 'z', 'members'])
    expect(cloud.count).toBe(1)
    expect([...cloud.ids]).toEqual([7])
    expect([...cloud.members]).toEqual([3])
    expect(cloud.positions[0]).toBeCloseTo(0.1)
    expect(cloud.positions[2]).toBeCloseTo(0.3)
  })

  it('follows another column order', () => {
    const cloud = cloudArrays([[0.5, 9, 0, 0, 1]], ['x', 'id', 'y', 'z', 'members'])
    expect(cloud.ids[0]).toBe(9)
    expect(cloud.positions[0]).toBeCloseTo(0.5)
  })

  it('grows a dot for the pictures it stands for, up to +40% at four', () => {
    const cloud = cloudArrays([[1, 0, 0, 0, 1], [2, 0, 0, 0, 4], [3, 0, 0, 0, 50]])
    const base = basePointSize(3)
    expect(cloud.sizes[0]).toBeCloseTo(base)
    expect(cloud.sizes[1]).toBeCloseTo(base * 1.4)
    expect(cloud.sizes[2]).toBeCloseTo(base * 1.4)
  })

  it('keeps dots visible but small on big maps', () => {
    expect(basePointSize(10)).toBe(MAX_POINT_SIZE)
    expect(basePointSize(1_000_000)).toBe(MIN_POINT_SIZE)
  })

  it('builds 30k dots quickly', () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => [i + 1, Math.sin(i), Math.cos(i), (i % 100) / 100, 1 + (i % 3)])
    const started = performance.now()
    const cloud = cloudArrays(rows)
    const core = coreBox(cloud.positions, cloud.count)
    expect(cloud.count).toBe(30_000)
    expect(core).not.toBeNull()
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('the central mass and the floor', () => {
  it('ignores a far outlier', () => {
    const rows = Array.from({ length: 100 }, (_, i) => [i + 1, i / 100, 0, 0, 1])
    rows.push([999, 50, 0, 0, 1])
    const cloud = cloudArrays(rows)
    const core = coreBox(cloud.positions, cloud.count)!
    expect(core.max[0]).toBeLessThan(1)
  })

  it('lays the grid just under the cloud with its padding', () => {
    const floor = floorGrid({ min: [-1, -1, -1], max: [1, 1, 1] })
    expect(floor.floorY).toBeCloseTo(-1 - GRID_PAD * 1.5)
    expect(floor.cloudTopY).toBe(1)
    expect(floor.corners[0]).toEqual([-1 - GRID_PAD, floor.floorY, -1 - GRID_PAD])
    expect(floor.vertices.length).toBe(11 * 12)
  })

  it('has no mass without dots', () => {
    expect(coreBox(new Float32Array(0), 0)).toBeNull()
  })
})

describe('regions and lookups', () => {
  it('gives each dot its nearest region centre', () => {
    const cloud = cloudArrays([[1, -1, 0, 0, 1], [2, 1, 0, 0, 1], [3, 0.9, 0, 0, 1]])
    const labels = assignRegions(cloud.positions, cloud.count, [{ center: [-1, 0, 0] }, { center: [1, 0, 0] }])
    expect([...labels]).toEqual([0, 1, 1])
    expect([...assignRegions(cloud.positions, cloud.count, [])]).toEqual([-1, -1, -1])
  })

  it('finds a picture by its id', () => {
    expect(indexOfId(Int32Array.from([5, 6, 7]), 7)).toBe(2)
    expect(indexOfId(Int32Array.from([5]), 8)).toBe(-1)
  })
})

describe('dots on the canvas (box select)', () => {
  const cloud = cloudArrays([[1, -0.5, 0.5, 0, 1], [2, 0.5, -0.5, 0, 1], [3, 0, 0, 5, 1]])
  const projected = projectPoints(cloud.positions, cloud.count, IDENTITY)

  it('projects to 0..1 with v down and drops dots outside the depth range', () => {
    expect(projected[0]).toBeCloseTo(0.25)
    expect(projected[1]).toBeCloseTo(0.25)
    expect(projected[2]).toBe(1)
    expect(projected[8]).toBe(0) // z = 5 is past the far plane
  })

  it('picks the visible dots inside a box drawn either way', () => {
    expect(dotsInRect(projected, cloud.count, { u: 0, v: 0 }, { u: 0.5, v: 0.5 })).toEqual([0])
    expect(dotsInRect(projected, cloud.count, { u: 1, v: 1 }, { u: 0, v: 0 })).toEqual([0, 1])
  })

  it('finds the nearest visible dot within the radius', () => {
    expect(nearestDot(projected, cloud.count, { u: 0.26, v: 0.25 }, { width: 100, height: 100, radiusPx: 9 })).toBe(0)
    expect(nearestDot(projected, cloud.count, { u: 0.5, v: 0.5 }, { width: 100, height: 100, radiusPx: 9 })).toBe(-1)
  })

  it('picks the visible dots inside a lasso, an odd outline included', () => {
    const square = [
      { u: 0.1, v: 0.1 },
      { u: 0.4, v: 0.1 },
      { u: 0.4, v: 0.4 },
      { u: 0.1, v: 0.4 },
    ]
    expect(dotsInPolygon(projected, cloud.count, square)).toEqual([0])
    // A "C" shape whose gap holds the dot at (0.75, 0.75): it is not picked.
    const hook = [
      { u: 0.6, v: 0.6 },
      { u: 0.95, v: 0.6 },
      { u: 0.95, v: 0.7 },
      { u: 0.7, v: 0.7 },
      { u: 0.7, v: 0.8 },
      { u: 0.95, v: 0.8 },
      { u: 0.95, v: 0.9 },
      { u: 0.6, v: 0.9 },
    ]
    expect(dotsInPolygon(projected, cloud.count, hook)).toEqual([])
    expect(dotsInPolygon(projected, cloud.count, square.slice(0, 2))).toEqual([])
  })

  it('a point is inside a polygon by the even-odd rule', () => {
    const triangle = [
      { u: 0, v: 0 },
      { u: 1, v: 0 },
      { u: 0, v: 1 },
    ]
    expect(insidePolygon({ u: 0.2, v: 0.2 }, triangle)).toBe(true)
    expect(insidePolygon({ u: 0.8, v: 0.8 }, triangle)).toBe(false)
  })
})
