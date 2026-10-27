import { describe, expect, it } from 'vitest'
import { cachedMapQuery, isFiltered, mapQuery, mapSignature, scopeParams, searchBody } from './mapRequest'
import { PREF_KEYS, readPrefs, storedValue } from './prefs'

const OFFICIAL = { model_source: 'huggingface' as const, model_path: null }

describe('map requests', () => {
  it('names the Style Finder model only for the Kaloscope map', () => {
    const kalo = new URLSearchParams(mapQuery({ space: 'kaloscope', token: 'T', model: { model_source: 'local', model_path: 'D:/m.pth' } }))
    expect(kalo.get('space')).toBe('kaloscope')
    expect(kalo.get('selection_token')).toBe('T')
    expect(kalo.get('model_source')).toBe('local')
    expect(kalo.get('model_path')).toBe('D:/m.pth')
    const clip = new URLSearchParams(mapQuery({ space: 'clip', token: null, model: { model_source: 'local', model_path: 'D:/m.pth' } }))
    expect(clip.has('model_source')).toBe(false)
    expect(clip.has('selection_token')).toBe(false)
  })

  it('leaves out a path for a downloaded model and empty extras', () => {
    const q = new URLSearchParams(mapQuery({ space: 'kaloscope', token: null, model: { model_source: 'modelscope', model_path: 'x' } }, { by: 'folder', skip: null }))
    expect(q.has('model_path')).toBe(false)
    expect(q.get('by')).toBe('folder')
    expect(q.has('skip')).toBe(false)
  })

  it('names a cached map by its handle instead of the filter token', () => {
    const q = new URLSearchParams(cachedMapQuery({ space: 'csd', token: 'LONG', model: OFFICIAL }, 'abc', { k: 20 }))
    expect(q.get('map_id')).toBe('abc')
    expect(q.has('selection_token')).toBe(false)
    expect(q.get('k')).toBe('20')
  })

  it('keys a lookup by space, map and layout', () => {
    expect(mapSignature('kaloscope', 'm1', 'pca')).toBe('kaloscope|m1|pca')
    expect(mapSignature('clip', undefined, undefined)).toBe('clip||')
  })

  it('asks for a fixed order (a random one has no token) and tells a filter from the whole library', () => {
    expect(scopeParams({ sort_by: 'random', tags: 'a' })).toEqual({ sort_by: 'newest', tags: 'a' })
    expect(isFiltered({ sort_by: 'newest' })).toBe(false)
    expect(isFiltered({ sort_by: 'newest', folder: 'x' })).toBe(true)
  })

  it('reads the find box in the library search language and keeps what it did not understand', () => {
    const named = searchBody('tag:smile rating:nonsense')
    expect(named.body).toMatchObject({ tags: ['smile'], sortBy: 'newest' })
    expect(named.ignored).toEqual(['rating:nonsense'])
    expect(searchBody('rating:nonsense').body).toBeNull()
    expect(searchBody('hello.png').body).toMatchObject({ search: 'hello.png' })
  })
})

describe('remembered choices', () => {
  it('reads stored choices and falls back to the defaults', () => {
    const store: Record<string, string> = { [PREF_KEYS.space]: 'csd', [PREF_KEYS.colorBy]: 'folder', [PREF_KEYS.landmarks]: 'off' }
    expect(readPrefs((k) => store[k] ?? null)).toEqual({ space: 'csd', colorBy: 'folder', landmarks: false, labels: true })
    expect(readPrefs(() => 'junk')).toEqual({ space: 'kaloscope', colorBy: 'generator', landmarks: true, labels: true })
    expect(
      readPrefs(() => {
        throw new Error('blocked')
      }),
    ).toEqual({ space: 'kaloscope', colorBy: 'generator', landmarks: true, labels: true })
  })

  it('writes switches the way the classic page does', () => {
    expect(storedValue(true)).toBe('on')
    expect(storedValue(false)).toBe('off')
    expect(storedValue('clip')).toBe('clip')
  })
})
