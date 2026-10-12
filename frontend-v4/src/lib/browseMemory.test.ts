import { describe, expect, test } from 'vitest'
import { EMPTY_SCOPE, isBrowsingAll, parseBrowseStore, recallBrowse, rememberBrowse } from './browseMemory'

describe('per-library search memory', () => {
  test('each library gets back its own search and rail scope', () => {
    let store = rememberBrowse({}, 'main', { queryText: 'tag:cat_ears', scope: { ...EMPTY_SCOPE, favorites: true } })
    store = rememberBrowse(store, 'lib-2', { queryText: 'gen:nai', scope: { generators: ['nai'], folder: 'D:/art', favorites: false } })
    expect(recallBrowse(store, 'main')).toEqual({ queryText: 'tag:cat_ears', scope: { generators: [], folder: null, favorites: true } })
    expect(recallBrowse(store, 'lib-2')).toEqual({ queryText: 'gen:nai', scope: { generators: ['nai'], folder: 'D:/art', favorites: false } })
  })

  test('a library never searched opens on everything', () => {
    expect(recallBrowse({}, 'new-one')).toEqual({ queryText: '', scope: EMPTY_SCOPE })
  })

  test('remembering does not change the store it was given', () => {
    const before = rememberBrowse({}, 'main', { queryText: 'a', scope: EMPTY_SCOPE })
    const after = rememberBrowse(before, 'main', { queryText: 'b', scope: EMPTY_SCOPE })
    expect(recallBrowse(before, 'main').queryText).toBe('a')
    expect(recallBrowse(after, 'main').queryText).toBe('b')
  })

  test('clearing everything forgets the entry instead of storing an empty one', () => {
    const store = rememberBrowse({ main: { queryText: 'x', scope: EMPTY_SCOPE } }, 'main', { queryText: '  ', scope: EMPTY_SCOPE })
    expect(store).toEqual({})
  })

  test('survives a reload: what was written reads back, and damaged storage reads as nothing', () => {
    const store = rememberBrowse({}, 'main', { queryText: 'tag:a|b', scope: { generators: ['nai'], folder: null, favorites: false } })
    expect(parseBrowseStore(JSON.stringify(store))).toEqual(store)
    expect(parseBrowseStore(null)).toEqual({})
    expect(parseBrowseStore('{broken')).toEqual({})
    expect(parseBrowseStore('[1,2]')).toEqual({})
    // wrong shapes inside are dropped or repaired field by field
    expect(
      parseBrowseStore(JSON.stringify({ a: 5, b: { queryText: 7 }, c: { queryText: 'q', scope: { generators: [1, 'nai'], folder: 3, favorites: 'yes' } } })),
    ).toEqual({ c: { queryText: 'q', scope: { generators: ['nai'], folder: null, favorites: false } } })
  })

  test('browsing all: no text and no rail scope', () => {
    expect(isBrowsingAll({ queryText: ' ', scope: EMPTY_SCOPE })).toBe(true)
    expect(isBrowsingAll({ queryText: 'x', scope: EMPTY_SCOPE })).toBe(false)
    expect(isBrowsingAll({ queryText: '', scope: { ...EMPTY_SCOPE, folder: 'D:/a' } })).toBe(false)
    expect(isBrowsingAll({ queryText: '', scope: { ...EMPTY_SCOPE, generators: ['nai'] } })).toBe(false)
    expect(isBrowsingAll({ queryText: '', scope: { ...EMPTY_SCOPE, favorites: true } })).toBe(false)
  })
})
