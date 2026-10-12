import { describe, expect, it } from 'vitest'
import { isStartPage, namesPage, startRoute } from './route'

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
