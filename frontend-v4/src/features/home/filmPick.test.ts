import { describe, expect, test } from 'vitest'
import type { ImageSummary } from '../../api/types'
import { FILM_LENGTH, frameRatio, framesThatFit, pickFrames, stepFrame } from './filmPick'

function img(id: number, extra: Partial<ImageSummary> = {}): ImageSummary {
  return {
    id,
    filename: `img-${id}.png`,
    path: `C:/lib/img-${id}.png`,
    generator: 'nai',
    width: 832,
    height: 1216,
    file_size: 1000,
    checkpoint: null,
    checkpoint_normalized: null,
    loras: null,
    user_rating: 0,
    aesthetic_score: null,
    is_readable: 1,
    metadata_status: 'complete',
    created_at: null,
    library_order_time: null,
    ...extra,
  }
}

const range = (from: number, count: number, extra: Partial<ImageSummary> = {}) =>
  Array.from({ length: count }, (_, i) => img(from + i, extra))

const ids = (frames: { image: ImageSummary }[]) => frames.map((f) => f.image.id)

describe('home film strip: which images it shows', () => {
  test('★5 images come first in their newest-first order, then the newest images fill the strip', () => {
    const starred = [img(7, { user_rating: 5 }), img(3, { user_rating: 5 })]
    const newest = range(20, 10)
    const frames = pickFrames(starred, newest, 6)
    expect(ids(frames)).toEqual([7, 3, 20, 21, 22, 23])
    expect(frames.map((f) => f.starred)).toEqual([true, true, false, false, false, false])
  })

  test('an image that is both ★5 and among the newest shows once, as ★5', () => {
    const starred = [img(21, { user_rating: 5 }), img(9, { user_rating: 5 })]
    const newest = [img(20), img(21, { user_rating: 5 }), img(22), img(9, { user_rating: 5 }), img(23)]
    const frames = pickFrames(starred, newest, 5)
    expect(ids(frames)).toEqual([21, 9, 20, 22, 23])
    expect(new Set(ids(frames)).size).toBe(frames.length)
  })

  test('the strip holds exactly its length when the library has enough images', () => {
    expect(pickFrames(range(1, 40, { user_rating: 5 }), range(100, 40), FILM_LENGTH)).toHaveLength(FILM_LENGTH)
    expect(pickFrames([], range(100, 40), FILM_LENGTH)).toHaveLength(FILM_LENGTH)
    expect(ids(pickFrames(range(1, 30, { user_rating: 5 }), range(100, 5), 4))).toEqual([1, 2, 3, 4])
  })

  test('a small library shows everything it has, and an empty one shows nothing', () => {
    expect(ids(pickFrames([img(1, { user_rating: 5 })], [img(1, { user_rating: 5 }), img(2)], FILM_LENGTH))).toEqual([1, 2])
    expect(pickFrames([], [], FILM_LENGTH)).toEqual([])
  })

  test('with no ★5 image the strip is the newest images', () => {
    expect(ids(pickFrames([], range(50, 8), 5))).toEqual([50, 51, 52, 53, 54])
  })

  test('images whose file is gone are left out, and the next ones take their place', () => {
    const starred = [img(1, { user_rating: 5, is_readable: 0 }), img(2, { user_rating: 5 })]
    const newest = [img(10), img(11, { is_readable: 0 }), img(12), img(13)]
    expect(ids(pickFrames(starred, newest, 3))).toEqual([2, 10, 12])
  })
})

describe('home film strip: frame shapes and how many fit', () => {
  test('a frame keeps the picture shape, within limits; unknown sizes are portrait', () => {
    expect(frameRatio(img(1, { width: 800, height: 1200 }))).toBeCloseTo(2 / 3)
    expect(frameRatio(img(1, { width: 1200, height: 800 }))).toBeCloseTo(1.5)
    expect(frameRatio(img(1, { width: 6000, height: 1000 }))).toBe(2)
    expect(frameRatio(img(1, { width: 300, height: 3000 }))).toBe(0.5)
    expect(frameRatio(img(1, { width: null, height: null }))).toBeCloseTo(2 / 3)
    expect(frameRatio(img(1, { width: 0, height: 900 }))).toBeCloseTo(2 / 3)
  })

  test('as many whole frames as the room holds, with the gaps between them', () => {
    // frames 100 px tall: 50, 100 and 150 px wide, 10 px apart
    const ratios = [0.5, 1, 1.5]
    expect(framesThatFit(ratios, 100, 10, 50)).toBe(1)
    expect(framesThatFit(ratios, 100, 10, 159)).toBe(1)
    expect(framesThatFit(ratios, 100, 10, 160)).toBe(2)
    expect(framesThatFit(ratios, 100, 10, 320)).toBe(3)
    expect(framesThatFit(ratios, 100, 10, 5000)).toBe(3)
    expect(framesThatFit(ratios, 100, 10, 40)).toBe(0)
    expect(framesThatFit(ratios, 0, 10, 500)).toBe(0)
  })
})

describe('home film strip: arrow keys', () => {
  test('arrows move one frame and stop at the ends; Home and End jump', () => {
    expect(stepFrame(0, 'ArrowRight', 5)).toBe(1)
    expect(stepFrame(4, 'ArrowRight', 5)).toBe(4)
    expect(stepFrame(2, 'ArrowLeft', 5)).toBe(1)
    expect(stepFrame(0, 'ArrowLeft', 5)).toBe(0)
    expect(stepFrame(3, 'Home', 5)).toBe(0)
    expect(stepFrame(1, 'End', 5)).toBe(4)
  })

  test('other keys are not the strip’s', () => {
    expect(stepFrame(1, 'Enter', 5)).toBeNull()
    expect(stepFrame(1, 'ArrowDown', 5)).toBeNull()
    expect(stepFrame(0, 'ArrowRight', 0)).toBeNull()
  })
})
