import { describe, expect, test } from 'vitest'
import { parseTracked, withoutTracked, withTracked } from './mediaTracked'

const job = (id: string) => ({ id, label: `${id}.gif`, folder: 'D:/out', count: 1 })

describe('the tracked media jobs', () => {
  test('a stored list is read back, and a damaged one is dropped', () => {
    expect(parseTracked(JSON.stringify([job('a'), job('b')]))).toEqual([job('a'), job('b')])
    expect(parseTracked(null)).toEqual([])
    expect(parseTracked('not json')).toEqual([])
    expect(parseTracked('{"id":"a"}')).toEqual([])
    expect(parseTracked(JSON.stringify([{ id: '' }, null, 7, { id: 'ok' }]))).toEqual([{ id: 'ok', label: '', folder: '', count: 0 }])
  })

  test('adding a job twice keeps one entry, and a finished job leaves the list', () => {
    const list = withTracked(withTracked([], job('a')), job('b'))
    expect(withTracked(list, { ...job('a'), count: 4 })).toEqual([job('b'), { ...job('a'), count: 4 }])
    expect(withoutTracked(list, 'a')).toEqual([job('b')])
    expect(withoutTracked(list, 'missing')).toEqual(list)
  })
})
