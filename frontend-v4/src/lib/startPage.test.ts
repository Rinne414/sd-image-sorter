import { describe, expect, it } from 'vitest'
import { arrivalHash } from './appSwitch'
import { isStartPage, namesPage, startRoute, type StartPage } from './route'

const HOME = { page: 'home', batchId: null }
const LIBRARY = { page: 'library', batchId: null }

describe('the page V4 opens on', () => {
  it('a plain launch (no page in the address) opens the start page chosen in Settings', () => {
    expect(startRoute('', 'home')).toEqual(HOME)
    expect(startRoute('', 'library')).toEqual(LIBRARY)
    // "#" and "#/" name no page either
    expect(startRoute('#', 'home')).toEqual(HOME)
    expect(startRoute('#/', 'library')).toEqual(LIBRARY)
  })

  it('an address that names a page wins over the start page', () => {
    expect(startRoute('#/library', 'home')).toEqual(LIBRARY)
    expect(startRoute('#/home', 'library')).toEqual(HOME)
    expect(startRoute('#/batch/3', 'home')).toEqual({ page: 'batch', batchId: 3 })
    expect(startRoute('#/settings/about', 'library')).toEqual({ page: 'settings', tab: 'about' })
    expect(startRoute('#/whatever', 'home')).toEqual(LIBRARY)
  })

  it('knows which hashes name a page', () => {
    expect(namesPage('')).toBe(false)
    expect(namesPage('#')).toBe(false)
    expect(namesPage('#/')).toBe(false)
    expect(namesPage('#/sort')).toBe(true)
  })

  it('accepts only the two start pages from storage', () => {
    expect(isStartPage('home')).toBe(true)
    expect(isStartPage('library')).toBe(true)
    expect(isStartPage('batch')).toBe(false)
    expect(isStartPage(undefined)).toBe(false)
  })
})

/**
 * Coming back from V3.5 (?library=): state/arrival.ts first puts the page V4
 * was left from into an address that names none, then the store opens
 * startRoute on that address. The same two steps, in the same order.
 */
function launch(hash: string, start: StartPage, arriving: { saved: string | null } | null) {
  return startRoute(arriving ? arrivalHash(hash, arriving.saved) : hash, start)
}

describe('start page × address × coming back from V3.5', () => {
  it('coming back reopens the page V4 was left from, whatever the start page', () => {
    expect(launch('', 'home', { saved: '#/batch/7' })).toEqual({ page: 'batch', batchId: 7 })
    expect(launch('', 'library', { saved: '#/settings/about' })).toEqual({ page: 'settings', tab: 'about' })
    expect(launch('#/', 'home', { saved: '#/sort' })).toEqual({ page: 'sort', batchId: null })
  })

  it('coming back with no page to reopen opens the start page', () => {
    expect(launch('', 'home', { saved: null })).toEqual(HOME)
    expect(launch('', 'library', { saved: null })).toEqual(LIBRARY)
  })

  it('an address that names a page wins over both', () => {
    expect(launch('#/batch', 'home', { saved: '#/sort' })).toEqual({ page: 'batch', batchId: null })
    expect(launch('#/home', 'library', null)).toEqual(HOME)
  })
})
