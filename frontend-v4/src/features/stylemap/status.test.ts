import { describe, expect, it } from 'vitest'
import { format } from '../../i18n'
import { enStyleMap } from '../../i18n/en.stylemap'
import { zhCNStyleMap } from '../../i18n/zh-CN.stylemap'
import { followPause, hasPoints, indexButton, layoutLine, layoutPending, remainingMs, remainingText, scopeSentence, startClock, startCard, unlocatableCount, workingMs } from './status'
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
    expect(remainingMs(0, 10, 4000)).toBeNull()
    expect(remainingMs(5, 10, null)).toBeNull()
    expect(remainingMs(5, 10, 1000)).toBeNull()
    expect(remainingMs(10, 10, 4000)).toBeNull()
    expect(remainingMs(5, 10, 10_000)).toBe(10_000)
  })

  it('is said in the user\'s language: seconds, minutes and hours, two-digit parts', () => {
    expect(remainingText(42_000)).toEqual({ key: 'stylemap.time.seconds', params: { s: 42 } })
    expect(remainingText(125_000)).toEqual({ key: 'stylemap.time.minutes', params: { m: 2, s: '05' } })
    expect(remainingText(3_900_000)).toEqual({ key: 'stylemap.time.hours', params: { h: 1, m: '05' } })
    expect(format(zhCNStyleMap['stylemap.time.minutes'], remainingText(125_000).params)).toBe('2 分 05 秒')
    expect(format(enStyleMap['stylemap.time.minutes'], remainingText(125_000).params)).toBe('2m 05s')
  })

  it('leaves paused time out of the working time', () => {
    let clock = startClock(0)
    expect(workingMs(clock, 10_000)).toBe(10_000)
    clock = followPause(clock, true, 10_000)
    // Paused for a minute: no work counted.
    expect(workingMs(clock, 70_000)).toBe(10_000)
    expect(followPause(clock, true, 20_000)).toBe(clock)
    clock = followPause(clock, false, 70_000)
    expect(clock).toEqual({ startedAt: 0, pausedMs: 60_000, pausedSince: null })
    expect(workingMs(clock, 80_000)).toBe(20_000)
    // 4 of 10 done in 20 s of work: 30 s left, not the 2 min 0 s the wall clock would say.
    expect(remainingMs(4, 10, workingMs(clock, 80_000))).toBe(30_000)
  })

  it('a job found already paused starts its pause at once', () => {
    const clock = startClock(1000, true)
    expect(workingMs(clock, 9000)).toBe(0)
  })
})
