import type { ImageSummary } from '../../../api/types'
import { isVideo } from '../../video/videoMedia'

// Which library items are moving pictures (a GIF or a video), and splitting a
// pick into the stills the censor editor takes and the moving pictures that
// go through the GIF and video censor.

export type MovingKind = 'gif' | 'video'

type Named = Pick<ImageSummary, 'media_type'> & { filename?: string | null; path?: string | null }

const GIF_NAME = /\.gif$/i

export function movingKind(image: Named | null | undefined): MovingKind | null {
  if (!image) return null
  if (isVideo(image)) return 'video'
  return GIF_NAME.test(String(image.filename ?? image.path ?? '')) ? 'gif' : null
}

export interface MovingPick {
  id: number
  name: string
  path: string
  kind: MovingKind
}

export interface SplitPicks {
  /** Everything the censor editor can paint on, in the order picked. */
  pictures: number[]
  moving: MovingPick[]
}

type Known = Named & { filename: string; path: string }

/** `lookup` answers null for an id nobody has loaded: it is treated as a picture, as before. */
export function splitPicks(ids: readonly number[], lookup: (id: number) => Known | null): SplitPicks {
  const pictures: number[] = []
  const moving: MovingPick[] = []
  for (const id of ids) {
    const image = lookup(id)
    const kind = movingKind(image)
    if (image && kind) moving.push({ id, name: image.filename, path: image.path, kind })
    else pictures.push(id)
  }
  return { pictures, moving }
}

export interface MovingCounts {
  gifs: number
  videos: number
}

export function countMoving(picks: readonly Pick<MovingPick, 'kind'>[]): MovingCounts {
  const videos = picks.filter((p) => p.kind === 'video').length
  return { gifs: picks.length - videos, videos }
}
