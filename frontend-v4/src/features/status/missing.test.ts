import { describe, expect, test } from 'vitest'
import { chooserStart } from './chooserStart'

describe('chooserStart', () => {
  test('opens in the folder the backend suggests', () => {
    expect(chooserStart({ suggested_search_folder: 'D:\\output' }, ['D:\\output\\testing'])).toBe('D:\\output')
  })

  test('falls back to the first place the files used to be', () => {
    expect(chooserStart({ suggested_search_folder: '' }, ['D:\\old', 'D:\\older'])).toBe('D:\\old')
    expect(chooserStart(undefined, ['D:\\old'])).toBe('D:\\old')
  })

  test('has no start when nothing is known', () => {
    expect(chooserStart({}, [])).toBeNull()
  })
})
