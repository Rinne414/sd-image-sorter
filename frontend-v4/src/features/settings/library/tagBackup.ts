// Reading a tag backup file before importing it: how many of its images carry
// something to import (the backend skips the rest), without sending anything.
// Mirrors services/tagging/library_io.py `import_tags`: an entry counts when it
// has a tag with a non-blank name or a non-blank AI description.

import type { TagImportResult } from './types'

type Entry = Record<string, unknown>

export type TagFile =
  | { ok: true; images: Entry[]; total: number; usable: number; empty: number }
  | { ok: false; reason: 'json' | 'shape' }

const isEntry = (v: unknown): v is Entry => !!v && typeof v === 'object' && !Array.isArray(v)

function hasTag(tags: unknown): boolean {
  return Array.isArray(tags) && tags.some((t) => isEntry(t) && String(t.tag ?? '').trim() !== '')
}

function isUsable(entry: unknown): entry is Entry {
  if (!isEntry(entry)) return false
  return hasTag(entry.tags) || String(entry.ai_caption ?? '').trim() !== ''
}

export type SkipReason = 'not_found' | 'ambiguous' | 'already_tagged' | 'duplicate'

const REASONS: SkipReason[] = ['not_found', 'ambiguous', 'already_tagged', 'duplicate']

/** Why an import skipped what it skipped: the reasons that skipped anything, in the order they are listed. */
export function skipReasons(result: TagImportResult): { reason: SkipReason; n: number }[] {
  return REASONS.map((reason) => ({ reason, n: result[reason] })).filter((r) => r.n > 0)
}

export function readTagFile(text: string): TagFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'json' }
  }
  if (!isEntry(data) || !Array.isArray(data.images)) return { ok: false, reason: 'shape' }
  const images = data.images.filter(isUsable)
  return { ok: true, images, total: data.images.length, usable: images.length, empty: data.images.length - images.length }
}
