import { ruleTokens } from '../captionRules'
import type { DatasetForm } from '../datasetSettings'
import type { HeadInfo } from '../datasetTag'
import type { Entry } from '../entries'
import { isOwnEmpty } from './captionContent'

// What the editor's image list says about each image, and its filters.

export interface ItemMarks {
  /** The user wrote this caption (edited or restored in V4 or V3.5). */
  edited: boolean
  /** An AI run wrote it and nobody changed it since. */
  ai: boolean
  /** Nothing of its own: the export would write only the batch rules (or nothing). null: not known yet. */
  empty: boolean | null
  /** The caption cannot be edited (the image or its file is gone or changed). */
  locked: boolean
}

export type ListFilter = 'all' | 'edited' | 'ai' | 'empty'

export const LIST_FILTERS: readonly ListFilter[] = ['all', 'edited', 'ai', 'empty']

/** A never-edited image's caption says nothing of its own when every token is one the batch rules put there. */
export function ownEmpty(finalCaption: string, form: DatasetForm): boolean {
  return ruleTokens(finalCaption, form).every((token) => token.fromRule)
}

export function entryMarks(entry: Entry, head: HeadInfo | undefined, unedited: string | undefined, form: DatasetForm | null): ItemMarks {
  const locked = entry.imageId === null ? entry.ref.kind === 'library' || entry.status !== 'ok' : false
  const content = head?.content
  const edited = !!content && head?.author === 'user'
  const ai = !!content && head?.author === 'ai'
  const empty = content ? isOwnEmpty(content) : unedited !== undefined && form ? ownEmpty(unedited, form) : null
  return { edited, ai, empty, locked }
}

export function matches(marks: ItemMarks, filter: ListFilter): boolean {
  if (filter === 'edited') return marks.edited
  if (filter === 'ai') return marks.ai
  if (filter === 'empty') return marks.empty === true
  return true
}

export function filterCounts(all: readonly ItemMarks[]): Record<ListFilter, number> {
  const counts: Record<ListFilter, number> = { all: all.length, edited: 0, ai: 0, empty: 0 }
  for (const marks of all) {
    if (marks.edited) counts.edited += 1
    if (marks.ai) counts.ai += 1
    if (marks.empty === true) counts.empty += 1
  }
  return counts
}

/** The key `step` places away in `keys` (wrapping stops at the ends); the first key when `current` is not listed. */
export function stepKey(keys: readonly string[], current: string | null, step: number): string | null {
  if (keys.length === 0) return null
  const at = current === null ? -1 : keys.indexOf(current)
  if (at < 0) return keys[0] ?? null
  return keys[Math.max(0, Math.min(keys.length - 1, at + step))] ?? null
}

/** Where to go after `key` leaves the list: the next image, else the one before. */
export function afterRemoval(keys: readonly string[], key: string): string | null {
  const at = keys.indexOf(key)
  if (at < 0) return keys[0] ?? null
  return keys[at + 1] ?? keys[at - 1] ?? null
}
