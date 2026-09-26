import type { ImageSummary } from '../../api/types'

// The home film strip: which images it holds, how wide each frame is, how many
// frames fit the window, and where the arrow keys go. Pure, so tests hold it.

/** Images the strip holds; the window shows as many as fit, the big image steps through all. */
export const FILM_LENGTH = 24

/** Frame shapes stay between a tall portrait and a wide landscape, as on the V3.5 film. */
const MIN_RATIO = 0.5
const MAX_RATIO = 2
/** Most generated images are portrait: a frame whose size is unknown is drawn that way. */
const DEFAULT_RATIO = 2 / 3

export interface FilmFrame {
  image: ImageSummary
  /** Came from the ★5 images (the rest fills with the newest). */
  starred: boolean
}

const readable = (img: ImageSummary) => img.is_readable !== 0

/**
 * ★5 images first, in the order given (newest first), then the newest images
 * to fill the strip. Each image once; images whose file is gone are left out.
 */
export function pickFrames(starred: ImageSummary[], newest: ImageSummary[], length: number = FILM_LENGTH): FilmFrame[] {
  const frames: FilmFrame[] = []
  const seen = new Set<number>()
  const take = (list: ImageSummary[], isStarred: boolean) => {
    for (const image of list) {
      if (frames.length >= length) return
      if (seen.has(image.id) || !readable(image)) continue
      seen.add(image.id)
      frames.push({ image, starred: isStarred })
    }
  }
  take(starred, true)
  take(newest, false)
  return frames
}

/** Width over height of a frame for this image. */
export function frameRatio(img: ImageSummary): number {
  const { width, height } = img
  if (!width || !height) return DEFAULT_RATIO
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, width / height))
}

/** How many whole frames, `height` px tall and `gap` px apart, fit in `room` px. */
export function framesThatFit(ratios: number[], height: number, gap: number, room: number): number {
  if (height <= 0) return 0
  let used = 0
  let count = 0
  for (const ratio of ratios) {
    const next = used + (count > 0 ? gap : 0) + ratio * height
    if (next > room) break
    used = next
    count += 1
  }
  return count
}

/** The frame an arrow key (or Home / End) moves to; null when the key is not the strip's. */
export function stepFrame(index: number, key: string, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight':
      return Math.min(count - 1, index + 1)
    case 'ArrowLeft':
      return Math.max(0, index - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
