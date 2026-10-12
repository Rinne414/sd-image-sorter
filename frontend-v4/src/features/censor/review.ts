import { detectionsOf } from './detection'
import type { Op, RegionOp } from './ops'

// The review walk over a batch, apart from the screen so it can be tested:
// Enter approves the image and goes on to the next one not approved yet, S
// skips it, and "detect all" picks the images still to detect. A mark is
// null (never detected), false (detected, waiting) or true (approved).

export interface ReviewItem {
  imageId: number
  reviewed: boolean | null
}

export interface ReviewProgress {
  approved: number
  total: number
  /** Detected and waiting for review. */
  waiting: number
}

export function reviewProgress(items: readonly ReviewItem[]): ReviewProgress {
  return {
    approved: items.filter((i) => i.reviewed === true).length,
    total: items.length,
    waiting: items.filter((i) => i.reviewed === false).length,
  }
}

/** The first image after `from` (wrapping round, never `from` itself) that is not approved. */
export function nextToReview(items: readonly ReviewItem[], from: number): number | null {
  for (let step = 1; step < items.length; step++) {
    const i = (from + step) % items.length
    if (items[i]?.reviewed !== true) return i
  }
  return null
}

export interface ReviewMove {
  items: ReviewItem[]
  /** Where to go next; null: nothing else is waiting, stay. */
  next: number | null
}

export function approve(items: readonly ReviewItem[], index: number): ReviewMove {
  const next = items.map((item, i) => (i === index ? { ...item, reviewed: true } : item))
  return { items: next, next: nextToReview(next, index) }
}

export function skip(items: ReviewItem[], index: number): ReviewMove {
  return { items, next: nextToReview(items, index) }
}

/**
 * The images "detect all" works on: those never detected and not approved.
 * When every such image is done, the ones waiting for review are detected again.
 */
export function detectAllTargets(items: readonly ReviewItem[]): { ids: number[]; redetect: boolean } {
  const fresh = items.filter((i) => i.reviewed === null).map((i) => i.imageId)
  if (fresh.length > 0) return { ids: fresh, redetect: false }
  const waiting = items.filter((i) => i.reviewed === false).map((i) => i.imageId)
  return { ids: waiting, redetect: waiting.length > 0 }
}

/** Region n (1-based, list order) of the image. */
export function regionByNumber(ops: readonly Op[], n: number): RegionOp | null {
  return n >= 1 ? (detectionsOf(ops)[n - 1] ?? null) : null
}
