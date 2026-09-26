import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearResume, loadResume, RESUME_KEY, saveResume, withTargets } from './installResume'

describe('the model downloads left for after a restart', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const clip = { card: 'clip', variant: null, label: 'CLIP' }
  const artist = { card: 'artist', variant: null, label: 'Kaloscope', source: 'modelscope' }

  it('is still there after a reload (read back from storage), with the boot it was saved in', () => {
    saveResume({ items: [clip, artist], restart: true, bootId: 'boot-A' })
    const raw = store.get(RESUME_KEY)
    expect(raw).toBeTruthy()
    const again = loadResume()
    expect(again).toMatchObject({ items: [clip, artist], restart: true, bootId: 'boot-A' })
    expect(again?.savedAt).toBeGreaterThan(0)
  })

  it('an empty list is no list at all', () => {
    saveResume({ items: [clip], restart: false, bootId: null })
    saveResume({ items: [], restart: true, bootId: null })
    expect(store.has(RESUME_KEY)).toBe(false)
    expect(loadResume()).toBeNull()
    saveResume({ items: [clip], restart: false, bootId: null })
    clearResume()
    expect(loadResume()).toBeNull()
  })

  it('survives junk: bad JSON, items without a card, doubled items', () => {
    store.set(RESUME_KEY, '{nope')
    expect(loadResume()).toBeNull()
    store.set(
      RESUME_KEY,
      JSON.stringify({ items: [{ card: 'clip', label: 'CLIP' }, { label: 'no card' }, { card: 'clip', variant: null, label: 'again' }, 7], restart: 'yes' }),
    )
    expect(loadResume()).toMatchObject({ items: [{ card: 'clip', variant: null, label: 'CLIP' }], restart: false, bootId: null })
  })

  it('adds cards in front of a saved list without doubling one', () => {
    const wd = { card: 'wd14', variant: 'wd-swinv2-tagger-v3', label: 'WD14' }
    expect(withTargets([wd, clip], [clip, artist])).toEqual([wd, clip, artist])
    expect(withTargets([], [artist])).toEqual([artist])
  })
})
