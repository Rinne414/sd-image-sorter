import type { ImageSummary } from '../../../api/types'

// What a pick's images are (stills, GIFs, videos), for splitting it between
// the censor editor and the GIF and video censor. Rows the library already
// loaded are used as they are; the rest are asked for in chunks
// (POST /api/images/by-ids takes up to 2000 ids and answers each row's
// file name, path and media type), so a pick of thousands is a few requests,
// not one request per image.

/** The most ids /api/images/by-ids takes in one request (backend routers/image_lookup.py MAX_IDS). */
export const ROWS_PER_REQUEST = 2000

/**
 * The rows of these ids: `loaded` answers the ones already on hand, `fetchRows`
 * asks for the rest, one chunk per call. A chunk that fails stays unknown
 * (its ids are treated as stills, as the censor has always done for ids
 * nobody could look up).
 */
export async function lookupRows(
  ids: readonly number[],
  loaded: (id: number) => ImageSummary | null,
  fetchRows: (chunk: number[]) => Promise<ImageSummary[]>,
  perRequest = ROWS_PER_REQUEST,
): Promise<Map<number, ImageSummary>> {
  const known = new Map<number, ImageSummary>()
  const missing: number[] = []
  for (const id of ids) {
    const image = loaded(id)
    if (image) known.set(id, image)
    else if (!known.has(id)) missing.push(id)
  }
  const wanted = [...new Set(missing)]
  for (let i = 0; i < wanted.length; i += perRequest) {
    const chunk = wanted.slice(i, i + perRequest)
    try {
      for (const image of await fetchRows(chunk)) known.set(image.id, image)
    } catch {
      // unknown: treated as stills, as before
    }
  }
  return known
}
