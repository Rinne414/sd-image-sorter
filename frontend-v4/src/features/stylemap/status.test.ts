import { describe, expect, it } from 'vitest'
import { formatRemaining, hasPoints, indexButton, layoutLine, layoutPending, remainingMs, scopeSentence, startCard, unlocatableCount } from './status'
import type { PointsAnswer } from './types'

const ok = (over: Partial<PointsAnswer> = {}): PointsAnswer => ({ status: 'ok', points: [[1, 0, 0, 0, 1]], total_images: 10, missing_vectors: 0, ...over })

describe('the layout line', () => {
  it('offers the UMAP install only when it is not installed, and a retry only after a failed fit', () => {
    const unavailable = layoutLine({ status: 'unavailable' }, 'pca')
    expect(unavailable).toMatchObject({ install: true, retry: false, key: 'stylemap.layout.unavailable', tip: 'stylemap.layout.unavailableTip' })
    expect(layoutLine({ status: 'failed', error: 'boom' }, 'pca')).toMatchObject({ install: false, retry: true, tone: 'failed' })
    expect(layoutLine({ status: 'computing' }, 'pca')).toMatchObject({ tone: 'busy', install: false, retry: false })
  })

  it('reads a UMAP map without a status as ready, and an unknown status as the quick layout', () => {
    expect(layoutLine(undefined, 'umap').key).toBe('stylemap.layout.ready')
    expect(layoutLine({ status: 'something new' }, 'pca').key).toBe('stylemap.layout.pca')
  })

  it('keeps asking only while the fit is queued or computing', () => {
    expect(layoutPending('queued')).toBe(true)
    expect(layoutPending('computing')).toBe(true)
    expect(layoutPending('ready')).toBe(false)
    expect(layoutPending(undefined)).toBe(false)
  })
})

describe('what the map covers', () => {
  it('says which pictures lack data, for a filter or the whole library', () => {
    expect(scopeSentence(ok({ missing_vectors: 3 }), true)).toEqual({ key: 'stylemap.scope.some', params: { total: 10, missing: 3 } })
    expect(scopeSentence(ok({ missing_vectors: 3 }), false).key).toBe('stylemap.scope.someLibrary')
    expect(scopeSentence(ok(), false)).toEqual({ key: 'stylemap.scope.allLibrary', params: { total: 10 } })
    expect(scopeSentence({ status: 'empty', total_images: 0 }, true).key).toBe('stylemap.scope.empty')
    expect(scopeSentence({ status: 'empty', total_images: 0 }, false).key).toBe('stylemap.scope.emptyAll')
  })

  it('counts the pictures that cannot be placed', () => {
    expect(unlocatableCount(ok({ unlocatable: [4, 5] }))).toBe(2)
    expect(unlocatableCount(ok())).toBe(0)
  })

  it('has points only for an ok answer with dots', () => {
    expect(hasPoints(ok())).toBe(true)
    expect(hasPoints(ok({ points: [] }))).toBe(false)
    expect(hasPoints({ status: 'no_vectors' })).toBe(false)
    expect(hasPoints(null)).toBe(false)
  })
})

describe('the index button and the start card', () => {
  it('builds while pictures lack data and refreshes once all have it; none for CLIP or while running', () => {
    expect(indexButton(ok({ missing_vectors: 2 }), 'kaloscope', false)).toEqual({ key: 'stylemap.index.build', primary: true })
    expect(indexButton(ok(), 'kaloscope', false)).toEqual({ key: 'stylemap.index.refresh', primary: false })
    expect(indexButton(ok({ missing_vectors: 1 }), 'csd', false)?.key).toBe('stylemap.index.buildCsd')
    expect(indexButton(ok(), 'clip', false)).toBeNull()
    expect(indexButton(ok(), 'kaloscope', true)).toBeNull()
    expect(indexButton({ status: 'empty' }, 'kaloscope', false)).toBeNull()
  })

  it('shows the start card only when there is nothing to draw, with the button that fills it', () => {
    expect(startCard(ok(), 'kaloscope', false)).toBeNull()
    expect(startCard({ status: 'empty' }, 'kaloscope', false)).toBeNull()
    expect(startCard(null, 'kaloscope', false)).toBeNull()
    expect(startCard({ status: 'no_vectors' }, 'kaloscope', false)).toMatchObject({ title: 'stylemap.empty.title', action: 'build' })
    expect(startCard({ status: 'no_vectors' }, 'csd', false)).toMatchObject({ title: 'stylemap.empty.titleCsd', action: 'build' })
    expect(startCard({ status: 'no_vectors' }, 'clip', false)).toMatchObject({ title: 'stylemap.empty.titleClip', action: 'buildClip' })
    expect(startCard({ status: 'no_vectors' }, 'kaloscope', true)).toMatchObject({ eyebrow: 'stylemap.empty.eyebrowRunning', action: null })
  })
})

describe('time left', () => {
  it('waits for a pace before guessing', () => {
    expect(remainingMs(0, 10, 1000, 5000)).toBeNull()
    expect(remainingMs(5, 10, null, 5000)).toBeNull()
    expect(remainingMs(5, 10, 1000, 2000)).toBeNull()
    expect(remainingMs(10, 10, 1000, 5000)).toBeNull()
    expect(remainingMs(5, 10, 1000, 11_000)).toBe(10_000)
  })

  it('writes seconds, minutes and hours', () => {
    expect(formatRemaining(42_000)).toBe('42s')
    expect(formatRemaining(125_000)).toBe('2m 05s')
    expect(formatRemaining(3_900_000)).toBe('1h 05m')
  })
})
