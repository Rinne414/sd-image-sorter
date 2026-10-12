// The Order step's hover preview, as V3.5's queue had it: after a 400 ms
// hover a larger picture shows beside the pointer; and the aesthetic score on
// the tiles. Pure; HoverPreview.tsx and useBatchScores.ts use it.

export const HOVER_DELAY_MS = 400

export interface Size {
  w: number
  h: number
}

/** The largest preview: 640 px, at most 60 % of the window's height and 40 % of its width. */
const MAX_SIDE = 640

/** The preview's size: the picture's shape, as large as the window allows, never larger than the picture. */
export function previewBox(width: number | null, height: number | null, viewport: Size): Size {
  const max = Math.min(MAX_SIDE, Math.round(viewport.h * 0.6), Math.round(viewport.w * 0.4))
  if (!width || !height) return { w: max, h: max }
  const scale = Math.min(max / width, max / height, 1)
  return { w: Math.round(width * scale), h: Math.round(height * scale) }
}

const OFFSET_X = 16
const OFFSET_Y = 60
const MARGIN = 8

/**
 * The pointer and the window in page px, where the preview is placed and sized:
 * under the interface zoom (130 % on 2560 px screens) the pointer is in screen
 * px and the window keeps its screen size, while the preview's CSS is in page px.
 */
export function pagePlace(pointer: { x: number; y: number }, window: Size, zoom: number): { pointer: { x: number; y: number }; viewport: Size } {
  return {
    pointer: { x: pointer.x / zoom, y: pointer.y / zoom },
    viewport: { w: Math.round(window.w / zoom), h: Math.round(window.h / zoom) },
  }
}

/** Where the preview goes: right of the pointer and a little above it, flipped or held inside the window. */
export function hoverPlace(pointer: { x: number; y: number }, box: Size, viewport: Size): { left: number; top: number } {
  let left = pointer.x + OFFSET_X
  if (left + box.w + MARGIN > viewport.w) left = pointer.x - OFFSET_X - box.w
  left = Math.max(MARGIN, left)
  const top = Math.max(MARGIN, Math.min(pointer.y - OFFSET_Y, viewport.h - box.h - MARGIN))
  return { left, top }
}

/** The scores that exist, by image id. */
export function scoreMap(rows: readonly { id: number; aesthetic_score: number | null }[]): Map<number, number> {
  return new Map(rows.flatMap((row) => (typeof row.aesthetic_score === 'number' ? [[row.id, row.aesthetic_score] as [number, number]] : [])))
}

export function idChunks(ids: readonly number[], size: number): number[][] {
  const out: number[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}
