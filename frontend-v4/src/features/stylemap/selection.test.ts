import { describe, expect, it } from 'vitest'
import { boxStyle, dragShape, idsAt, keptOnMap, lassoPoints, pickedDots, pickFlags, toggled, withMembers } from './selection'

describe('what a press on the map draws', () => {
  it('turns the map by default; Shift + drag draws a box', () => {
    expect(dragShape('rotate', false, 0)).toBeNull()
    expect(dragShape('rotate', true, 0)).toBe('box')
  })

  it('draws the chosen shape with a plain drag, Shift or not', () => {
    expect(dragShape('box', false, 0)).toBe('box')
    expect(dragShape('lasso', false, 0)).toBe('lasso')
    expect(dragShape('lasso', true, 0)).toBe('lasso')
  })

  it('leaves the right and middle buttons to the map (pan)', () => {
    expect(dragShape('box', true, 2)).toBeNull()
    expect(dragShape('lasso', false, 1)).toBeNull()
  })
})

describe('the pick', () => {
  const ids = Int32Array.from([10, 20, 30, 40])

  it('flags the picked dots in point order', () => {
    expect([...pickFlags(ids, new Set([20, 40, 99]))]).toEqual([0, 1, 0, 1])
    expect([...pickFlags(ids, new Set())]).toEqual([0, 0, 0, 0])
  })

  it('names the dots of a box by their picture ids', () => {
    expect([...idsAt([0, 2, 7], ids)]).toEqual([10, 30])
  })

  it('a click adds a dot, a second click takes it out (the old pick is not changed)', () => {
    const before = new Set([10])
    const added = toggled(before, 20)
    expect([...added]).toEqual([10, 20])
    expect([...toggled(added, 10)]).toEqual([20])
    expect([...before]).toEqual([10])
  })

  it('keeps only the picks still on a redrawn map', () => {
    expect([...keptOnMap(new Set([10, 30, 55]), Int32Array.from([30, 10, 77]))].sort()).toEqual([10, 30])
  })

  it('asks for the merged pictures only when a picked dot stands for more than itself', () => {
    const members = Uint16Array.from([1, 3, 1, 1])
    expect(pickedDots(ids, members, new Set([10, 30]))).toEqual({ reps: [10, 30], merged: false })
    expect(pickedDots(ids, members, new Set([20, 40]))).toEqual({ reps: [20, 40], merged: true })
  })

  it('every picture once, the dots first', () => {
    expect(withMembers([20, 40], [21, 20, 22, 40])).toEqual([20, 40, 21, 22])
  })
})

describe('the drawn shape', () => {
  it('a box between any two corners, in percent of the canvas', () => {
    expect(boxStyle({ u: 0.5, v: 0.8 }, { u: 0.25, v: 0.2 })).toEqual({ left: '25.000%', top: '20.000%', width: '25.000%', height: '60.000%' })
  })

  it('a lasso as SVG points on a 0..100 square', () => {
    expect(lassoPoints([{ u: 0.1, v: 0.2 }, { u: 0.5, v: 0.75 }])).toBe('10.00,20.00 50.00,75.00')
  })
})
