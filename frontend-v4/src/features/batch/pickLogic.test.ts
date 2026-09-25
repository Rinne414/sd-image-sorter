import { describe, expect, test } from 'vitest'
import { clickSelection, keepPresent, NO_PICKS, removalKeys, selectAll } from './pickLogic'

const order = ['lib:1', 'dir:C:/a.png', 'lib:2', 'lib:3', 'dir:C:/b.png']
const plain = { ctrl: false, shift: false }
const ctrl = { ctrl: true, shift: false }
const shift = { ctrl: false, shift: true }

describe('pick step selection', () => {
  test('a plain click only moves the cursor and drops the selection', () => {
    const picked = clickSelection(NO_PICKS, order, 1, ctrl)
    const after = clickSelection(picked, order, 3, plain)
    expect([...after.keys]).toEqual([])
    expect(after.anchor).toBe(3)
  })

  test('Ctrl toggles one image; Shift selects the run from the last click', () => {
    const one = clickSelection(NO_PICKS, order, 1, ctrl)
    const two = clickSelection(one, order, 3, ctrl)
    expect([...two.keys]).toEqual(['dir:C:/a.png', 'lib:3'])
    expect([...clickSelection(two, order, 3, ctrl).keys]).toEqual(['dir:C:/a.png'])

    const run = clickSelection(clickSelection(NO_PICKS, order, 4, plain), order, 2, shift)
    expect([...run.keys]).toEqual(['lib:2', 'lib:3', 'dir:C:/b.png'])
    expect(one.keys.size).toBe(1)
  })

  test('select all, and images that left drop out of the selection', () => {
    const all = selectAll(order)
    expect(all.keys.size).toBe(5)
    const kept = keepPresent(all, ['lib:1', 'lib:3'])
    expect([...kept.keys]).toEqual(['lib:1', 'lib:3'])
    expect(keepPresent(kept, ['lib:1', 'lib:3'])).toBe(kept)
  })

  test('Delete takes the selection in batch order, else the image under the cursor', () => {
    const sel = { keys: new Set(['lib:3', 'lib:1']), anchor: 0 }
    expect(removalKeys(sel, order, 4)).toEqual(['lib:1', 'lib:3'])
    expect(removalKeys(NO_PICKS, order, 4)).toEqual(['dir:C:/b.png'])
    expect(removalKeys(NO_PICKS, order, -1)).toEqual([])
  })
})
