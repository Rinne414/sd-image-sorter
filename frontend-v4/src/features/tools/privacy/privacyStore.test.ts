import { describe, expect, it } from 'vitest'
import { compatOf, readOptions } from './privacyStore'

describe('privacy settings', () => {
  it('start as Standard, keeping the generation details, modern algorithm', () => {
    expect(readOptions(null)).toEqual({ mode: 'standard', keepInfo: true, legacyInfo: false, advancedOpen: false })
    expect(readOptions('not json')).toEqual(readOptions(null))
    expect(readOptions('[1]')).toEqual({ mode: 'standard', keepInfo: true, legacyInfo: false, advancedOpen: false })
  })

  it('come back as saved, and only known values are taken', () => {
    expect(readOptions(JSON.stringify({ mode: 'simple', keepInfo: false, legacyInfo: true, advancedOpen: true }))).toEqual({ mode: 'simple', keepInfo: false, legacyInfo: true, advancedOpen: true })
    expect(readOptions(JSON.stringify({ mode: 'weird', keepInfo: 'yes', legacyInfo: 1, password: '0512' }))).toEqual({ mode: 'standard', keepInfo: true, legacyInfo: false, advancedOpen: false })
  })

  it('the plain mode names map to the Tomato engines', () => {
    expect(compatOf('standard')).toBe('big_tomato')
    expect(compatOf('simple')).toBe('small_tomato')
  })
})
