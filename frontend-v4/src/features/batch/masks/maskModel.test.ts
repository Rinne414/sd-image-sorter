import { describe, expect, it } from 'vitest'
import { createPainter, createScratch } from '../../censor/paint'
import { createRaster } from '../../censor/raster'
import { coverage, fullMask, grayValue, invertInPlace, pushState, redoState, renderMask, strokeOp, undoState, type MaskAction, type MaskState } from './maskModel'

const at = (state: MaskState, x: number, y: number, w = 20, h = 20) => grayValue(renderMask(w, h, state), x, y)
const drop = (points: number[], size = 4): MaskAction => ({ kind: 'stroke', tool: 'drop', size, points })
const keep = (points: number[], size = 4): MaskAction => ({ kind: 'stroke', tool: 'keep', size, points })

describe('a training mask (white = train, black = leave out)', () => {
  it('starts with the whole picture trained', () => {
    expect(coverage(fullMask(4, 3))).toBe(1)
    expect(at({ base: null, actions: [] }, 0, 0)).toBe(255)
  })

  it('the leave-out brush paints black, the keep brush white again; only under the brush', () => {
    const state: MaskState = { base: null, actions: [drop([10, 10, 10, 10], 6)] }
    expect(at(state, 10, 10)).toBe(0)
    expect(at(state, 0, 0)).toBe(255)
    expect(at({ base: null, actions: [...state.actions, keep([10, 10], 2)] }, 10, 10)).toBe(255)
    expect(at({ base: null, actions: [...state.actions, keep([10, 10], 2)] }, 12, 10)).toBe(0)
  })

  it('invert flips everything painted so far', () => {
    const state: MaskState = { base: null, actions: [drop([10, 10], 6), { kind: 'invert' }] }
    expect(at(state, 10, 10)).toBe(255)
    expect(at(state, 0, 0)).toBe(0)
  })

  it('starts from a stored or automatic mask, soft edges kept', () => {
    const base = createRaster(2, 1, new Uint8ClampedArray([0, 0, 0, 255, 128, 128, 128, 255]))
    const out = renderMask(2, 1, { base, actions: [] })
    expect([grayValue(out, 0, 0), grayValue(out, 1, 0)]).toEqual([0, 128])
    expect(base.data[4]).toBe(128)
    const inverted = createRaster(2, 1, new Uint8ClampedArray(base.data))
    invertInPlace(inverted)
    expect([grayValue(inverted, 0, 0), grayValue(inverted, 1, 0)]).toEqual([255, 127])
  })

  it('a stroke painted live, a few points at a time, gives the same pixels as its replay', () => {
    const action = drop([2, 2, 9, 4, 15, 15, 3, 17], 5)
    const live = fullMask(20, 20)
    const painter = createPainter(live, live, strokeOp(action as Extract<MaskAction, { kind: 'stroke' }>), createScratch(20, 20))
    painter.add([2, 2, 9, 4])
    painter.add([15, 15])
    painter.add([3, 17])
    expect(Array.from(live.data)).toEqual(Array.from(renderMask(20, 20, { base: null, actions: [action] }).data))
  })

  it('coverage is the share of the picture trained', () => {
    const half = createRaster(2, 1, new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]))
    expect(coverage(half)).toBe(0.5)
  })
})

describe('undo and redo', () => {
  const s0: MaskState = { base: null, actions: [] }
  const s1: MaskState = { base: null, actions: [drop([1, 1])] }
  const s2: MaskState = { base: null, actions: [drop([1, 1]), { kind: 'invert' }] }

  it('undo goes back one change at a time, redo forward; a new change forgets what was undone', () => {
    let h = pushState(pushState({ past: [], future: [] }, s0), s1)
    const back = undoState(h, s2)
    expect(back?.state).toBe(s1)
    h = back!.history
    const again = redoState(h, s1)
    expect(again?.state).toBe(s2)
    const branched = pushState(h, s1)
    expect(branched.future).toEqual([])
    expect(undoState({ past: [], future: [] }, s0)).toBeNull()
    expect(redoState({ past: [], future: [] }, s0)).toBeNull()
  })
})
