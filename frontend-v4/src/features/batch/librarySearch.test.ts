import { describe, expect, it } from 'vitest'
import { parseSearch } from '../../lib/searchQuery'
import { favoriteKeys, fromLibrarySearch } from './librarySearch'

// "Use the library's current search" in a batch: the library's search line
// plus its left-rail scope, as a batch condition that matches what the
// library shows (V3.5's "use gallery filters").

const NO_SCOPE = { generators: [], folder: null, favorites: false }

describe('the library search as a batch condition', () => {
  it('copies the search line as it is', () => {
    expect(fromLibrarySearch('  tag:1girl score>=6 ', NO_SCOPE)).toEqual({ text: 'tag:1girl score>=6', favorites: false })
  })

  it('writes the rail generators into the condition', () => {
    const got = fromLibrarySearch('tag:cat', { ...NO_SCOPE, generators: ['nai', 'comfyui'] })
    expect(got.text).toBe('tag:cat gen:nai gen:comfyui')
    expect(parseSearch(got.text).generators).toEqual(['nai', 'comfyui'])
  })

  it('does not repeat a generator the line already names', () => {
    expect(fromLibrarySearch('gen:nai', { ...NO_SCOPE, generators: ['nai'] }).text).toBe('gen:nai')
  })

  it('writes the rail folder, quoted, so a path with spaces stays one value', () => {
    const got = fromLibrarySearch('', { ...NO_SCOPE, folder: 'L:\\My Pics\\keep' })
    expect(got.text).toBe('folder:"L:\\My Pics\\keep"')
    expect(parseSearch(got.text).scalars.folder).toBe('L:\\My Pics\\keep')
  })

  it('leaves the rail folder out when the line names its own (the library does the same)', () => {
    expect(fromLibrarySearch('folder:a', { ...NO_SCOPE, folder: 'b' }).text).toBe('folder:a')
  })

  it('carries "only favorites" as a flag, since the search language has no word for it', () => {
    expect(fromLibrarySearch('tag:cat', { ...NO_SCOPE, favorites: true })).toEqual({ text: 'tag:cat', favorites: true })
  })

  it('gives an empty condition for a library that shows everything', () => {
    expect(fromLibrarySearch('   ', NO_SCOPE)).toEqual({ text: '', favorites: false })
  })
})

describe('the favorites part of a batch condition', () => {
  const entries = [
    { key: 'l:1', imageId: 1 },
    { key: 'l:2', imageId: 2 },
    { key: 'f:a', imageId: null },
  ]
  const favorites = new Set([2, 7])

  it('keeps the matches that are favorites', () => {
    expect([...favoriteKeys(entries, new Set(['l:1', 'l:2']), favorites)]).toEqual(['l:2'])
  })

  it('without a text condition, matches every favorite in the batch (folder images never)', () => {
    expect([...favoriteKeys(entries, null, favorites)]).toEqual(['l:2'])
  })
})
