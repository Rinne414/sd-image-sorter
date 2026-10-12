import type { LibraryRoot } from './types'

// Pure reading of the source-folder list.

export function rootsSummary(roots: readonly LibraryRoot[]): { folders: number; missing: number } {
  return { folders: roots.length, missing: roots.filter((r) => r.exists === false).length }
}

/** The folders that are gone from the disk, in the list order. */
export function missingRoots(roots: readonly LibraryRoot[]): LibraryRoot[] {
  return roots.filter((r) => r.exists === false)
}

/** After removing several: how many went, and the names of the ones that could not be removed. */
export function removalSummary(results: readonly { root: LibraryRoot; ok: boolean }[]): { removed: number; failed: string[] } {
  return { removed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => rootName(r.root.path)) }
}

/** Folders that are still there first (in the backend's order, newest first), then the ones that are gone. */
export function orderRoots(roots: readonly LibraryRoot[]): LibraryRoot[] {
  return [...roots.filter((r) => r.exists !== false), ...roots.filter((r) => r.exists === false)]
}

/** "2026-09-06T21:58:03" → "2026-09-06 21:58". */
export function scannedAt(iso: string | null): string | null {
  if (!iso) return null
  return iso.replace('T', ' ').slice(0, 16)
}

/** The folder's own name (the whole path for a drive root). */
export function rootName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const last = parts.at(-1)
  if (!last || (parts.length === 1 && last.endsWith(':'))) return path
  return last
}
