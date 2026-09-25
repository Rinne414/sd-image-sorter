import type { DatasetProjectItem, DatasetProjectItemRequest } from '../../api/types'

// Pure rules for a dataset batch's images, which live in its Dataset Maker
// project: Library images by id, folder images by path. Every function
// returns new data and leaves its input alone.

/** A dataset image's identity. */
export type EntryRef = { kind: 'library'; imageId: number } | { kind: 'folder'; path: string }

/** One spelling for a path, so C:\a\b.png and C:/a/b.png are the same image. */
export function pathKey(path: string): string {
  return path.replace(/\\/g, '/')
}

export const libraryKey = (imageId: number) => `lib:${imageId}`
export const folderKey = (path: string) => `dir:${pathKey(path)}`

export function refKey(ref: EntryRef): string {
  return ref.kind === 'library' ? libraryKey(ref.imageId) : folderKey(ref.path)
}

/** What a saved project entry is (a Library entry keeps its id even when the image is gone). */
export function savedRef(item: DatasetProjectItem): EntryRef {
  return item.item_type === 'library' ? { kind: 'library', imageId: item.source_image_id } : { kind: 'folder', path: item.path }
}

/** A new folder image the backend was never shown (no scan or upload surfaced it). */
export class UnsurfacedFolderImage extends Error {
  readonly path: string

  constructor(path: string) {
    super(`The folder image ${path} was not found by a folder scan or an upload`)
    this.name = 'UnsurfacedFolderImage'
    this.path = path
  }
}

/**
 * The PUT items that make the project hold `next`, in that order. An entry
 * the saved project already has goes back `keep_as_saved` (its stored
 * identity and missing mark stay as they are); a new Library image goes by
 * id; a new folder image goes by path, and only when a scan or upload
 * surfaced it (`surfaced`, by pathKey). A repeated entry keeps its first place.
 */
export function projectPutItems(
  saved: readonly DatasetProjectItem[],
  next: readonly EntryRef[],
  surfaced: ReadonlySet<string>,
): DatasetProjectItemRequest[] {
  const savedByKey = new Map(saved.map((item) => [refKey(savedRef(item)), item]))
  const seen = new Set<string>()
  const out: DatasetProjectItemRequest[] = []
  for (const ref of next) {
    const key = refKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    const kept = savedByKey.get(key)
    if (kept) {
      out.push(
        kept.item_type === 'library'
          ? { item_type: 'library', image_id: kept.source_image_id, keep_as_saved: true }
          : { item_type: 'local', path: kept.path, keep_as_saved: true },
      )
    } else if (ref.kind === 'library') {
      out.push({ item_type: 'library', image_id: ref.imageId, keep_as_saved: false })
    } else if (surfaced.has(pathKey(ref.path))) {
      out.push({ item_type: 'local', path: ref.path, keep_as_saved: false })
    } else {
      throw new UnsurfacedFolderImage(ref.path)
    }
  }
  return out
}

/** `current` with `extra` appended; entries it already has are counted as skipped. */
export function withAdded(current: readonly EntryRef[], extra: readonly EntryRef[]): { refs: EntryRef[]; added: number; skipped: number } {
  const have = new Set(current.map(refKey))
  const refs = [...current]
  let skipped = 0
  for (const ref of extra) {
    const key = refKey(ref)
    if (have.has(key)) {
      skipped += 1
      continue
    }
    have.add(key)
    refs.push(ref)
  }
  return { refs, added: refs.length - current.length, skipped }
}

export function withoutKeys(current: readonly EntryRef[], keys: ReadonlySet<string>): EntryRef[] {
  return current.filter((ref) => !keys.has(refKey(ref)))
}

/**
 * `current` in the order of `keys`. Entries `keys` does not name (added
 * meanwhile) keep their relative order at the end; unknown keys are ignored.
 */
export function inOrder(current: readonly EntryRef[], keys: readonly string[]): EntryRef[] {
  const rank = new Map(keys.map((key, i) => [key, i]))
  const known = current.filter((ref) => rank.has(refKey(ref))).sort((a, b) => (rank.get(refKey(a)) ?? 0) - (rank.get(refKey(b)) ?? 0))
  const rest = current.filter((ref) => !rank.has(refKey(ref)))
  return [...known, ...rest]
}

/**
 * The entries after an undo put removed ones back: each in its old place
 * among what is still there, anything added meanwhile at the end.
 */
export function restoreRefs(before: readonly EntryRef[], present: readonly EntryRef[], removed: readonly EntryRef[]): EntryRef[] {
  const back = new Set([...present, ...removed].map(refKey))
  const known = new Set(before.map(refKey))
  return [...before.filter((ref) => back.has(refKey(ref))), ...present.filter((ref) => !known.has(refKey(ref)))]
}
