import { describe, expect, it } from 'vitest'
import { regionsFromDetections } from './detection'
import { applyDetectRun } from './detection'
import type { Op, StrokeOp } from './ops'
import { approve, detectAllTargets, nextToReview, regionByNumber, reviewProgress, skip, type ReviewItem } from './review'

const items = (...marks: (boolean | null)[]): ReviewItem[] => marks.map((reviewed, i) => ({ imageId: 100 + i, reviewed }))

describe('review walk', () => {
  it('progress counts approved images of the whole batch', () => {
    expect(reviewProgress(items(true, false, null, true))).toEqual({ approved: 2, total: 4, waiting: 1 })
    expect(reviewProgress([])).toEqual({ approved: 0, total: 0, waiting: 0 })
  })

  it('Enter approves the image and moves to the next one not approved, wrapping round', () => {
    const start = items(false, true, false, null)
    const a = approve(start, 0)
    expect(a.items.map((i) => i.reviewed)).toEqual([true, true, false, null])
    expect(a.items).not.toBe(start)
    expect(a.next).toBe(2)
    const b = approve(a.items, 2)
    expect(b.next).toBe(3)
    const c = approve(b.items, 3)
    expect(c.items.every((i) => i.reviewed === true)).toBe(true)
    // nothing left to review: stay where you are
    expect(c.next).toBeNull()
  })

  it('S skips without approving; skipping past the end wraps to the first image still waiting', () => {
    const list = items(false, true, false)
    expect(skip(list, 0)).toEqual({ items: list, next: 2 })
    expect(skip(list, 2)).toEqual({ items: list, next: 0 })
    // the only image left: skipping has nowhere to go
    expect(skip(items(true, false, true), 1).next).toBeNull()
  })

  it('the next image to review after any position; null when everything is approved', () => {
    expect(nextToReview(items(true, true, false), 0)).toBe(2)
    expect(nextToReview(items(false, true, true), 2)).toBe(0)
    expect(nextToReview(items(true, true), 0)).toBeNull()
    expect(nextToReview(items(null), 0)).toBeNull()
    expect(nextToReview(items(null, true), 1)).toBe(0)
  })
})

describe('detect all', () => {
  it('detects the images never detected and not approved; when none are left, re-detects the ones waiting', () => {
    expect(detectAllTargets(items(true, null, false, null))).toEqual({ ids: [101, 103], redetect: false })
    expect(detectAllTargets(items(true, false, false))).toEqual({ ids: [101, 102], redetect: true })
    expect(detectAllTargets(items(true, true))).toEqual({ ids: [], redetect: false })
  })
})

describe('number keys', () => {
  it('1-9 name the regions in list order; manual strokes are not counted', () => {
    const stroke: StrokeOp = { type: 'stroke', id: 's', tool: 'brush', style: 'mosaic', size: 5, block: 4, color: '#000000', opacity: 100, points: [1, 1] }
    const opts = { detector: 'nudenet', style: 'mosaic' as const, block: 8, maskShape: 'box' as const, confidence: 0, width: 50, height: 50 }
    const regions = regionsFromDetections(
      [
        { box: [1, 1, 5, 5], class: 'a', confidence: 0.9 },
        { box: [6, 6, 9, 9], class: 'b', confidence: 0.8 },
      ],
      opts,
      null,
    )
    const ops: Op[] = applyDetectRun([stroke], regions)
    expect(regionByNumber(ops, 1)?.label).toBe('a')
    expect(regionByNumber(ops, 2)?.label).toBe('b')
    expect(regionByNumber(ops, 3)).toBeNull()
    expect(regionByNumber(ops, 0)).toBeNull()
  })
})
