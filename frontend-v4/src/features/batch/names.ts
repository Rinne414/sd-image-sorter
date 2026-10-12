// The Name step's rules apart from the screen. The final names themselves come
// from the server (POST /api/batches/{id}/export/names), which uses the
// export's own code, so the preview and the files never disagree.

export interface NamePreviewItem {
  image_id: number
  position: number
  filename: string
  has_censored: boolean
  /** False when the export leaves this image out. */
  included: boolean
  source: 'censored' | 'original' | 'missing' | null
  number: number | null
  overridden: boolean
  output_name: string | null
}

export interface NamePreview {
  items: NamePreviewItem[]
  duplicates: { output_name: string; image_ids: number[] }[]
  template_error: { token: string; message: string } | null
}

/** Tokens offered next to the template input, in the order shown. */
export const TEMPLATE_TOKENS = ['{batch}', '{n}', '{n:02}', '{n:03}', '{original}', '{date}', '{time}'] as const

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * {date} (YYYYMMDD) and {time} (HHMMSS) filled in with `when`, local time, as
 * V3.5's rename did: the moment the names are made, not the file's own date.
 * The page fills them; the server renders every other token.
 */
export function stampTemplate(template: string, when: Date): string {
  const date = `${when.getFullYear()}${pad2(when.getMonth() + 1)}${pad2(when.getDate())}`
  const time = `${pad2(when.getHours())}${pad2(when.getMinutes())}${pad2(when.getSeconds())}`
  return template.replaceAll('{date}', date).replaceAll('{time}', time)
}

/** Ids of images whose final name another image also gets (case-insensitive). */
export function duplicateIds(preview: NamePreview | undefined): Set<number> {
  return new Set(preview?.duplicates.flatMap((d) => d.image_ids) ?? [])
}

/** What stops "next": a broken template, names used twice, or no preview yet. */
export type NameBlock = 'template' | 'duplicates' | 'pending' | null

export function nameBlock(preview: NamePreview | undefined, stale: boolean): NameBlock {
  if (!preview || stale) return 'pending'
  if (preview.template_error) return 'template'
  return preview.duplicates.length > 0 ? 'duplicates' : null
}

/** Put a token into the template at the caret (replacing a selection); returns the text and the new caret. */
export function insertToken(value: string, token: string, start: number, end: number): { value: string; caret: number } {
  const from = Math.max(0, Math.min(start, value.length))
  const to = Math.max(from, Math.min(end, value.length))
  return { value: value.slice(0, from) + token + value.slice(to), caret: from + token.length }
}

/** An output name typed for one image: trimmed, empty means "use the template". */
export function cleanOverride(typed: string): string | null {
  const name = typed.trim()
  return name ? name : null
}
