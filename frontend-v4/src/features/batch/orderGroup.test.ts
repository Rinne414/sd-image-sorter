import { describe, expect, it } from 'vitest'
import { dropGroup, groupMove, moveGroup, moveInView } from './orderLogic'
import { HISTORY_DEPTH, NO_HISTORY, pushOrder, undoOrder } from './orderHistory'

const list = ['a', 'b', 'c', 'd', 'e', 'f']
const sel = (...keys: string[]) => new Set(keys)

describe('moving several images together (V3.5\'s queue rules)', () => {
  it('top and bottom keep the selection in its order', () => {
    expect(moveGroup(list, sel('e', 'b', 'd'), 'top')).toEqual(['b', 'd', 'e', 'a', 'c', 'f'])
    expect(moveGroup(list, sel('a', 'c'), 'bottom')).toEqual(['b', 'd', 'e', 'f', 'a', 'c'])
  })

  it('up and down move each selected image one place past its unselected neighbour', () => {
    expect(moveGroup(list, sel('c', 'e'), 'up')).toEqual(['a', 'c', 'b', 'e', 'd', 'f'])
    expect(moveGroup(list, sel('b', 'c'), 'down')).toEqual(['a', 'd', 'b', 'c', 'e', 'f'])
    // already at the edge: those stay, the others still move
    expect(moveGroup(list, sel('a', 'c'), 'up')).toEqual(['a', 'c', 'b', 'd', 'e', 'f'])
  })

  it('returns the same list when nothing moves', () => {
    expect(moveGroup(list, sel('a', 'b'), 'top')).toBe(list)
    expect(moveGroup(list, sel('e', 'f'), 'down')).toBe(list)
    expect(moveGroup(list, sel(), 'top')).toBe(list)
  })

  it('a dropped selection lands together before or after the image it was dropped on', () => {
    expect(dropGroup(list, sel('a', 'b'), 4, false)).toEqual(['c', 'd', 'a', 'b', 'e', 'f'])
    expect(dropGroup(list, sel('a', 'b'), 4, true)).toEqual(['c', 'd', 'e', 'a', 'b', 'f'])
    expect(dropGroup(list, sel('e', 'b'), 0, false)).toEqual(['b', 'e', 'a', 'c', 'd', 'f'])
    // dropped on one of its own: nothing moves
    expect(dropGroup(list, sel('a', 'b'), 1, true)).toBe(list)
  })
})

describe('reorder undo', () => {
  it('gives back the orders in reverse, and nothing after the last', () => {
    let h = pushOrder(NO_HISTORY, ['a', 'b'])
    h = pushOrder(h, ['b', 'a'])
    const first = undoOrder(h)
    expect(first?.order).toEqual(['b', 'a'])
    const second = undoOrder(first!.history)
    expect(second?.order).toEqual(['a', 'b'])
    expect(undoOrder(second!.history)).toBeNull()
  })

  it('keeps the last 50 orders, as V3.5 did', () => {
    expect(HISTORY_DEPTH).toBe(50)
    let h = NO_HISTORY
    for (let i = 0; i < 60; i++) h = pushOrder(h, [String(i)])
    let steps = 0
    let last: string[] | null = null
    for (let u = undoOrder(h); u; u = undoOrder(u.history)) {
      steps += 1
      last = [...u.order]
    }
    expect(steps).toBe(50)
    expect(last).toEqual(['10'])
  })
})

describe('moving while a filter hides some images', () => {
  const shown = sel('a', 'c', 'e')

  it('up and down step past the nearest shown image; hidden ones keep their places', () => {
    expect(moveInView(list, sel('e'), shown, 'up')).toEqual(['a', 'b', 'e', 'd', 'c', 'f'])
    expect(moveInView(list, sel('a'), shown, 'down')).toEqual(['c', 'b', 'a', 'd', 'e', 'f'])
  })

  it('top and bottom mean the whole batch, not only what is shown', () => {
    expect(moveInView(list, sel('e'), shown, 'top')).toEqual(['e', 'a', 'b', 'c', 'd', 'f'])
    expect(moveInView(list, sel('a'), shown, 'bottom')).toEqual(['b', 'c', 'd', 'e', 'f', 'a'])
  })

  it('without a filter it is the plain group move', () => {
    expect(moveInView(list, sel('c', 'e'), null, 'up')).toEqual(moveGroup(list, sel('c', 'e'), 'up'))
    expect(moveInView(list, sel('a'), shown, 'up')).toBe(list)
  })
})

describe('Alt + keys', () => {
  it('map to a group move, other keys to nothing', () => {
    expect(['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'Enter'].map(groupMove)).toEqual(['up', 'up', 'down', 'down', 'top', 'bottom', null])
  })
})
