// Dragging a card out of the library carries the ORIGINAL file (the
// full-resolution endpoint, which keeps the embedded workflow), as V3.5 did
// in gallery/card-markup.js: Chromium's DownloadURL lets Explorer save it,
// text/uri-list lets ComfyUI fetch and load it. A marker type tells our own
// text fields to refuse the drop instead of pasting the URL.

export const INTERNAL_DRAG = 'application/x-sd-image-sorter-image'

const MIME: Record<string, string> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

export function mimeOf(filename: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? ''
  return MIME[ext] ?? 'image/png'
}

/** The data a card drag carries, keyed by type. */
export function dragPayload(image: { id: number; filename: string }, origin: string): Record<string, string> {
  const url = new URL(`/api/image-file/${image.id}`, origin).href
  // DownloadURL is "mime:name:url"; a colon in the name would break it (Windows names never have one).
  const name = (image.filename || `image_${image.id}.png`).replace(/:/g, '_')
  return {
    DownloadURL: `${mimeOf(name)}:${name}:${url}`,
    'text/uri-list': url,
    'text/plain': url,
    [INTERNAL_DRAG]: String(image.id),
  }
}
