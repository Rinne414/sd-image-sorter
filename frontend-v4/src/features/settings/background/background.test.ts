import { describe, expect, it } from 'vitest'
import { translate, type MessageKey } from '../../../i18n'
import { describeLoaded, describeNote, idleOptions, modelName, readBackground, unloadMessages, type BackgroundState } from './background'

const t = (key: MessageKey, params?: Record<string, string | number>) => translate('en', key, params)
const clock = (s: number) => `T${s}`

const state = (over: Partial<BackgroundState> = {}): BackgroundState => ({ idle_unload_minutes: 10, models: [], last_release: null, gpu_busy_fallbacks: [], ...over })

describe('idleOptions', () => {
  it('offers the four standard choices', () => {
    expect(idleOptions(10).map((o) => o.value)).toEqual([5, 10, 30, 0])
  })
  it('adds a stored value that is none of them, so the select never shows a wrong choice', () => {
    const options = idleOptions(45)
    expect(options.at(-1)).toMatchObject({ value: 45, custom: true })
    expect(options).toHaveLength(5)
  })
})

describe('describeLoaded', () => {
  it('says plainly when nothing is loaded', () => {
    expect(describeLoaded(state(), t)).toBe('No AI model is loaded right now.')
  })
  it('names each model with its device and whether it is in use or idle', () => {
    const text = describeLoaded(
      state({ models: [{ key: 'clip', device: 'gpu', in_use: true, idle_seconds: 0 }, { key: 'tagger', device: 'cpu', in_use: false, idle_seconds: 185 }] }),
      t,
    )
    expect(text).toBe('Loaded now: CLIP search (GPU, in use), Tagger (CPU, idle 3 min)')
  })
  it('shows an unknown model by its key', () => {
    expect(modelName('brand-new', t)).toBe('brand-new')
  })
})

describe('describeNote', () => {
  it('puts a recent GPU fallback before the last release', () => {
    const s = state({ gpu_busy_fallbacks: [{ at: 5, label: 'tagger:wd-v3' }], last_release: { at: 9, keys: ['clip'] } })
    expect(describeNote(s, t, clock)).toBe('At T5 the GPU was busy, so wd-v3 ran on the CPU.')
  })
  it('names the last release, else nothing', () => {
    expect(describeNote(state({ last_release: { at: 9, keys: ['clip', 'artist'] } }), t, clock)).toBe('Freed at T9: CLIP search, Artist ID')
    expect(describeNote(state(), t, clock)).toBe('')
  })
})

describe('unloadMessages', () => {
  it('reports what was freed and what a running job kept', () => {
    const out = unloadMessages({ ...state(), released: ['clip'], busy: ['tagger'] }, t)
    expect(out).toEqual(['Freed: CLIP search', 'Kept Tagger: a running job is using it.'])
  })
  it('says there was nothing to free', () => {
    expect(unloadMessages({ ...state(), released: [], busy: [] }, t)).toEqual(['Nothing to free: no model is loaded.'])
  })
})

describe('readBackground', () => {
  it('rejects an answer that is not the loaded-models shape', () => {
    expect(readBackground(null)).toBeNull()
    expect(readBackground({ models: [] })).toBeNull()
    expect(readBackground('x')).toBeNull()
  })
  it('keeps the parts it understands', () => {
    const s = readBackground({ idle_unload_minutes: 5, models: [{ key: 'clip', device: 'gpu', in_use: false, idle_seconds: 61 }, { nope: 1 }], last_release: { at: 3, keys: ['clip'] }, gpu_busy_fallbacks: [{ at: 2 }, { x: 1 }] })
    expect(s?.models).toHaveLength(1)
    expect(s?.last_release).toEqual({ at: 3, keys: ['clip'] })
    expect(s?.gpu_busy_fallbacks).toEqual([{ at: 2 }])
  })
})
