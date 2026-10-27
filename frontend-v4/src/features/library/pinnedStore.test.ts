import { describe, expect, it } from 'vitest'
import { isSettingKey } from '../../lib/resetSettings'
import { parsePins, withPin } from './pinnedStore'

describe('the set of pictures each library shows from the Style Map', () => {
  it('is remembered per library, and forgetting one keeps the others', () => {
    const pins = withPin(withPin({}, 'main', { id: 41, count: 28 }), 'training', { id: 7, count: 3 })
    expect(pins).toEqual({ main: { id: 41, count: 28 }, training: { id: 7, count: 3 } })
    expect(withPin(pins, 'main', null)).toEqual({ training: { id: 7, count: 3 } })
    expect(pins.main).toEqual({ id: 41, count: 28 })
  })

  it('reads back what it wrote and drops what is damaged', () => {
    expect(parsePins(JSON.stringify({ main: { id: 41, count: 28 } }))).toEqual({ main: { id: 41, count: 28 } })
    expect(parsePins('not json')).toEqual({})
    expect(parsePins('[1,2]')).toEqual({})
    expect(parsePins(null)).toEqual({})
    expect(parsePins(JSON.stringify({ a: { id: 'x' }, b: { id: -2 }, c: null, d: { id: 5, count: 'many' } }))).toEqual({ d: { id: 5, count: 0 } })
  })

  it('is where the user was, not a setting: "Reset all settings" leaves it', () => {
    expect(isSettingKey('sd-v4-library-pins')).toBe(false)
  })
})
