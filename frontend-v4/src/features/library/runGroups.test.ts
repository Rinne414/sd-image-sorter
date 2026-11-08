import { describe, expect, test } from 'vitest'
import type { ImageSummary } from '../../api/types'
import { displayIndexOf, groupRuns, pickLabel, widenToStacks, type DisplayItem } from './runGroups'

const picture = (id: number, runKey: string | null, minute: number): ImageSummary =>
  ({ id, run_key: runKey, created_at: `2026-11-08T10:${String(minute).padStart(2, '0')}:00` }) as unknown as ImageSummary

const shape = (items: DisplayItem[]) =>
  items.map(
    (item) =>
      (item.stack
        ? `stack ${item.img.id} x${item.stack.size} [${item.stack.ids.join(',')}]`
        : item.member
          ? `member ${item.img.id} ${item.member.position + 1}/${item.member.size}`
          : `single ${item.img.id}`) + ` @${item.flatIndex}`,
  )

const images = [
  picture(1, 'a', 50), picture(2, 'a', 49), picture(3, 'a', 47), // one run
  picture(4, 'b', 46), // another prompt
  picture(5, 'a', 45), // the first prompt again, but not next to its run
  picture(6, 'c', 40), picture(7, 'c', 20), // same key, 20 minutes apart
  picture(8, null, 19), picture(9, null, 18), // no key: never grouped
]

describe('Group runs', () => {
  test('a run is next to each other, shares a key and stays within ten minutes', () => {
    expect(shape(groupRuns(images, new Set()))).toEqual([
      'stack 1 x3 [1,2,3] @0',
      'single 4 @3',
      'single 5 @4',
      'single 6 @5',
      'single 7 @6',
      'single 8 @7',
      'single 9 @8',
    ])
  })

  test('times in Unix seconds, as numbers or digits, split runs the same way', () => {
    const at = (id: number, seconds: number | string): ImageSummary =>
      ({ id, run_key: 'a', library_order_time: seconds, created_at: null }) as unknown as ImageSummary
    expect(shape(groupRuns([at(1, 1780000000), at(2, 1779999940), at(3, 1779998000)], new Set()))).toEqual([
      'stack 1 x2 [1,2] @0',
      'single 3 @2',
    ])
    expect(shape(groupRuns([at(1, '1780000000'), at(2, '1779999940')], new Set()))).toEqual(['stack 1 x2 [1,2] @0'])
  })

  test('the oldest-first order groups the same runs', () => {
    expect(shape(groupRuns([...images].reverse(), new Set())).at(-1)).toBe('stack 3 x3 [3,2,1] @6')
  })

  test('an open run shows every picture in place', () => {
    const key = groupRuns(images, new Set())[0]!.stack!.key
    expect(shape(groupRuns(images, new Set([key]))).slice(0, 4)).toEqual([
      'member 1 1/3 @0',
      'member 2 2/3 @1',
      'member 3 3/3 @2',
      'single 4 @3',
    ])
  })

  test('items hold the pictures themselves, so a later rating shows', () => {
    const list = [picture(1, 'a', 1), picture(2, 'a', 2)]
    const [stack] = groupRuns(list, new Set())
    list[0]!.user_rating = 5
    expect(stack!.img.user_rating).toBe(5)
  })

  test('a picture inside a closed stack is found at the stack', () => {
    const items = groupRuns(images, new Set())
    expect(displayIndexOf(items, 3)).toBe(0)
    expect(displayIndexOf(items, 4)).toBe(1)
    expect(displayIndexOf(items, null)).toBe(-1)
  })

  test('a range keeps every closed stack it touches whole', () => {
    const items = groupRuns(images, new Set())
    expect(widenToStacks(items, 1, 4)).toEqual([0, 4])
    expect(widenToStacks(items, 0, 0)).toEqual([0, 2])
    expect(widenToStacks(items, 3, 5)).toEqual([3, 5])
  })

  test('a stack is picked only when all of it is, and shows its orders as ranges', () => {
    const order = new Map([[1, 2], [2, 3], [3, 4], [9, 1]])
    expect(pickLabel([1, 2, 3], order)).toBe('2–4')
    expect(pickLabel([9], order)).toBe('1')
    expect(pickLabel([1, 2, 4], order)).toBe('')
    expect(pickLabel([1, 3, 9], new Map([[1, 1], [3, 4], [9, 6]]))).toBe('1, 4…')
  })
})
