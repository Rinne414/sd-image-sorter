import { describe, expect, it } from 'vitest'
import { cleanSetup, EMPTY_SETUP, hasFolder, startBody, withFavorites, withFolder } from './savedSetup'
import { readSession, slotTarget, type SessionView } from './sortSession'

// A sort key can add the image to Favorites instead of moving it into a folder
// (V3.5: a key could point at a folder or a collection). The key is a
// collection key whose collection is the built-in Favorites; the file stays
// where it is, and the key's add can be undone like any other key.

const FAV = 3

describe('a key on Favorites in the setup', () => {
  it('points a key at Favorites or at a folder, never both', () => {
    const fav = withFavorites(withFolder(EMPTY_SETUP, 'w', 'D:/keep'), 'w')
    expect(fav.folders.w).toBeUndefined()
    expect(fav.favorites).toEqual(['w'])
    const back = withFolder(fav, 'w', 'D:/keep')
    expect(back.favorites).toEqual([])
    expect(back.folders.w).toBe('D:/keep')
    expect(withFolder(withFavorites(EMPTY_SETUP, 'a'), 'a', null)).toMatchObject({ folders: {}, favorites: [] })
  })

  it('counts a key on Favorites as set, and never lists a key twice', () => {
    const twice = withFavorites(withFavorites(EMPTY_SETUP, 'd'), 'd')
    expect(twice.favorites).toEqual(['d'])
    expect(hasFolder(twice)).toBe(true)
  })

  it('reads the stored Favorites keys safely (old setups have none)', () => {
    expect(cleanSetup({ mode: 'slot', favorites: ['w', 'q', 7, 'w', 'd'] }).favorites).toEqual(['w', 'd'])
    expect(cleanSetup({ mode: 'slot' }).favorites).toEqual([])
  })

  it('starts the sort with the Favorites keys as collection keys on the Favorites collection', () => {
    const setup = withFavorites(withFolder(EMPTY_SETUP, 's', 'D:/s'), 'w')
    const body = startBody([1, 2], setup, false, FAV)
    expect(body.folders).toEqual({ s: 'D:/s' })
    expect(body.collection_slots).toEqual({ w: FAV })
    expect(startBody([1, 2], { ...setup, mode: 'cull' }, false, FAV).collection_slots).toEqual({})
  })
})

describe('what a key points at during the sort', () => {
  const view = readSession({
    image: { id: 11, filename: 'a.png', path: 'C:/in/a.png' },
    mode: 'slot',
    index: 0,
    total: 2,
    image_ids: [11, 12],
    folders: { s: 'D:/s' },
    collection_slots: { w: FAV, d: 44 },
    operation_mode: 'move',
  }) as SessionView

  it('names Favorites by the Favorites collection, and any other collection as V3.5 set it', () => {
    expect(slotTarget(view, 's', FAV)).toEqual({ kind: 'folder', path: 'D:/s' })
    expect(slotTarget(view, 'w', FAV)).toEqual({ kind: 'favorites' })
    expect(slotTarget(view, 'd', FAV)).toEqual({ kind: 'collection', id: 44 })
    expect(slotTarget(view, 'a', FAV)).toBeNull()
    // not known yet: the key still reads as a collection
    expect(slotTarget(view, 'w', null)).toEqual({ kind: 'collection', id: FAV })
  })
})
