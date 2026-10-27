import type { ImageSummary } from '../../api/types'
import { parseSearch } from '../../lib/searchQuery'
import { isKey, replaceTokens } from '../../lib/queryEdit'

// Video library items as pure rules: what is a video, how its length reads,
// which codecs a browser plays, which media filter the query line holds.

export type MediaFilter = '' | 'image' | 'video'

/** Tools that read the picture's pixels: "Send to tool" leaves videos out for these. */
export const PICTURE_ONLY_TOOLS: ReadonlySet<string> = new Set(['reverse', 'artist', 'privacy'])

const VIDEO_NAME = /\.(mp4|webm|mkv|mov|m4v)$/i
const DEFAULT_FPS = 24

/** Codecs a browser usually cannot decode: they go straight to the converted preview. */
const NON_BROWSER_CODECS = new Set(['prores', 'dnxhd', 'mpeg2video', 'mpeg4', 'msmpeg4v3', 'mjpeg', 'rawvideo', 'ffv1', 'cfhd'])

type Mediaish = Pick<ImageSummary, 'media_type'> & { filename?: string | null; path?: string | null }

export function isVideo(image: Mediaish | null | undefined): boolean {
  if (!image) return false
  if (image.media_type) return image.media_type === 'video'
  return VIDEO_NAME.test(String(image.filename ?? image.path ?? ''))
}

/** 0:05, 1:02:09. */
export function formatDuration(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`
}

export type BadgeKind = 'duration' | 'unreadable' | 'plain'

/** What a video tile's mark says: its length once read, otherwise that it is a video. */
export function badgeOf(image: Pick<ImageSummary, 'duration_seconds' | 'video_probe_state'>): { kind: BadgeKind; time: string } {
  if (image.duration_seconds) return { kind: 'duration', time: formatDuration(image.duration_seconds) }
  if (image.video_probe_state === 'unreadable') return { kind: 'unreadable', time: '' }
  return { kind: 'plain', time: '' }
}

export function canPreviewInBrowser(codec: string | null | undefined): boolean {
  return !codec || !NON_BROWSER_CODECS.has(String(codec).toLowerCase())
}

/** Where scrubbing a tile lands: the pointer's share of the tile's width (0 left edge, 1 right edge) of the clip; null while the length is unknown. */
export function scrubTime(fraction: number, duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null
  return Math.min(1, Math.max(0, fraction)) * duration
}

/** Where a frame step lands: one frame (or the default 24 per second) either way, kept inside the clip. */
export function stepTime(current: number, direction: 1 | -1, fps: number | null | undefined, duration: number): number {
  const rate = Number(fps) > 0 ? Number(fps) : DEFAULT_FPS
  const next = current + direction / rate
  const end = Number.isFinite(duration) ? duration : next
  return Math.max(0, Math.min(end, next))
}

/** The media filter a query line holds (the last media: token wins, as the parser applies it). */
export function mediaFilterOf(text: string): MediaFilter {
  const kind = parseSearch(text).scalars.mediaType
  return kind ?? ''
}

/** The query line with its media filter set to `kind` ('' removes it); the rest of the line stays. */
export function withMediaFilter(text: string, kind: MediaFilter): string {
  return replaceTokens(text, isKey('media'), kind ? [`media:${kind}`] : [])
}

/** The picture saved beside a video, when its generation info was read from it (metadata_json._parsed.video_recipe). */
export function companionRecipe(metadataJson: string | null | undefined): { file: string } | null {
  if (!metadataJson) return null
  try {
    const recipe = (JSON.parse(metadataJson) as { _parsed?: { video_recipe?: { source?: string; file?: string } } })._parsed?.video_recipe
    return recipe?.source === 'companion' ? { file: recipe.file ?? '' } : null
  } catch {
    return null
  }
}

export type VideoKey = { type: 'step'; dir: 1 | -1 } | { type: 'toggle' }

/** Keys of an open video: , and . step a frame, Space and K play or pause. Ctrl, Meta and Alt are left alone. */
export function videoKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): VideoKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.key === ',') return { type: 'step', dir: -1 }
  if (e.key === '.') return { type: 'step', dir: 1 }
  if (e.key === ' ' || e.key === 'k' || e.key === 'K') return { type: 'toggle' }
  return null
}

/** The video's facts as one line: size, length, codec, frame rate, file size. */
export function videoFacts(
  image: Pick<ImageSummary, 'width' | 'height' | 'duration_seconds' | 'video_codec' | 'file_size'> & { video_fps?: number | null },
  fpsText: (fps: number) => string,
  sizeText: (bytes: number) => string,
): string {
  const parts: string[] = []
  if (image.width && image.height) parts.push(`${image.width}×${image.height}`)
  if (image.duration_seconds) parts.push(formatDuration(image.duration_seconds))
  if (image.video_codec) parts.push(String(image.video_codec).toUpperCase())
  if (image.video_fps) parts.push(fpsText(Math.round(image.video_fps * 100) / 100))
  if (image.file_size) parts.push(sizeText(image.file_size))
  return parts.join(' • ')
}
