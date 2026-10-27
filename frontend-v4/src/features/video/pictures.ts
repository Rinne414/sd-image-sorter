import { findLoadedImage } from '../../api/loaded'
import { rawJson } from '../../api/raw'
import { translate, useLang } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { isVideo } from './videoMedia'

// Picture-only work (censoring, similarity, scoring, captioning, the privacy
// and reverse-prompt tools, datasets) leaves videos out. The loaded gallery
// pages say what is a video; ids that are not loaded (a "select all matches"
// pick) are asked of the backend once and remembered.

/** id -> is a video, for ids the backend has been asked about. */
const asked = new Map<number, boolean>()

/** True when the gallery already knows this image is a video. */
export function isKnownVideo(id: number): boolean {
  const loaded = findLoadedImage(id)
  if (loaded) return isVideo(loaded)
  return asked.get(id) === true
}

/** How many of these are known videos, without asking the backend (for greying out a menu entry). */
export function knownVideoCount(ids: readonly number[]): number {
  return ids.reduce((n, id) => n + (isKnownVideo(id) ? 1 : 0), 0)
}

/** Which of these are videos: the gallery's knowledge first, the backend for the rest. */
export async function videoIdsAmong(ids: readonly number[]): Promise<Set<number>> {
  const videos = new Set<number>()
  const unknown: number[] = []
  for (const id of ids) {
    const loaded = findLoadedImage(id)
    if (loaded) {
      if (isVideo(loaded)) videos.add(id)
    } else if (asked.has(id)) {
      if (asked.get(id)) videos.add(id)
    } else {
      unknown.push(id)
    }
  }
  if (unknown.length > 0) {
    const answer = await rawJson<{ video_ids: number[] }>('POST', '/api/videos/which', { body: { image_ids: unknown } })
    const found = new Set(answer.video_ids)
    for (const id of unknown) {
      asked.set(id, found.has(id))
      if (found.has(id)) videos.add(id)
    }
  }
  return videos
}

export interface PictureSplit {
  pictures: number[]
  videos: number[]
}

/** The ids as pictures and videos, in the order given. */
export async function splitPictures(ids: readonly number[]): Promise<PictureSplit> {
  const videos = await videoIdsAmong(ids)
  return { pictures: ids.filter((id) => !videos.has(id)), videos: ids.filter((id) => videos.has(id)) }
}

const say = (key: 'video.leftOut' | 'video.leftOutAll', n: number) => translate(useLang.getState().lang, key, { n })

/**
 * The pictures among these ids. When videos were among them, says how many were
 * left out (and, when nothing is left, that nothing was done). If the backend
 * cannot be asked, nothing is returned and the failure is said: a video must
 * never reach a picture-only route by guessing.
 */
export async function onlyPictures(ids: readonly number[]): Promise<number[]> {
  try {
    const { pictures, videos } = await splitPictures(ids)
    if (videos.length > 0) useToasts.getState().push(say(pictures.length > 0 ? 'video.leftOut' : 'video.leftOutAll', videos.length))
    return pictures
  } catch (error) {
    useToasts.getState().push(translate(useLang.getState().lang, 'error.generic', { reason: (error as Error).message }), 'error')
    return []
  }
}
