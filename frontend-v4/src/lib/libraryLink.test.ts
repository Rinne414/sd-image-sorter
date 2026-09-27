import { describe, expect, it } from 'vitest'
import { arrivalLibrary, libraryParam, withoutLibraryParam } from './libraryLink'

describe('the library a link carries', () => {
  it('reads ?library= from the address, trimmed; missing or empty carries nothing', () => {
    expect(libraryParam('?library=lib_2')).toBe('lib_2')
    expect(libraryParam('?skip-entry&library=%20lib-3%20')).toBe('lib-3')
    expect(libraryParam('')).toBeNull()
    expect(libraryParam('?library=')).toBeNull()
    expect(libraryParam('?other=1')).toBeNull()
  })

  it('switches only to a library this backend knows that is not already open', () => {
    const known = ['main', 'lib_2']
    expect(arrivalLibrary('lib_2', known, 'main')).toBe('lib_2')
    expect(arrivalLibrary('main', known, 'main')).toBeNull()
    // unknown (deleted, or another install's id): the app keeps its own choice
    expect(arrivalLibrary('gone', known, 'main')).toBeNull()
    expect(arrivalLibrary(null, known, 'main')).toBeNull()
  })

  it('drops only library= from the address and keeps everything else', () => {
    expect(withoutLibraryParam('?library=lib_2')).toBe('')
    expect(withoutLibraryParam('?library=')).toBe('')
    expect(withoutLibraryParam('?a=1&library=lib_2&b=2')).toBe('?a=1&b=2')
    expect(withoutLibraryParam('?a=1')).toBe('?a=1')
    expect(withoutLibraryParam('')).toBe('')
  })
})
