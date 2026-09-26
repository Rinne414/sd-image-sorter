import { describe, expect, it } from 'vitest'
import { arrivalHash, arrivalLibrary, libraryParam, switchHref, withoutLibraryParam } from './appSwitch'

describe('the library a switch link carries', () => {
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

describe('a link into the other app', () => {
  it('carries the open library, encoded', () => {
    expect(switchHref('/', 'main')).toBe('/?library=main')
    expect(switchHref('/', 'a b&c')).toBe('/?library=a%20b%26c')
  })
})

describe('the page V4 opens on when coming back', () => {
  it('reopens the page it was left from when the address names none', () => {
    expect(arrivalHash('', '#/batch/3')).toBe('#/batch/3')
    expect(arrivalHash('#', '#/settings/about')).toBe('#/settings/about')
    expect(arrivalHash('#/', '#/sort')).toBe('#/sort')
  })

  it('an address that names a page wins; nothing saved keeps the address', () => {
    expect(arrivalHash('#/sort', '#/batch/3')).toBe('#/sort')
    expect(arrivalHash('', null)).toBe('')
    expect(arrivalHash('', '')).toBe('')
  })
})
