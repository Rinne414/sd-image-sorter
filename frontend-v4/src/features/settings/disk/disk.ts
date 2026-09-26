import type { CacheEntry, CacheStatus, CleanResult } from './types'

// Pure reading of the disk page: the cache limit the user typed, sizes, and
// which caches to clean.

/** The backend's largest thumbnail cache limit (routers/disk.py). */
export const LIMIT_MAX_MB = 102400
/** The backend's default when nothing was saved. */
const DEFAULT_LIMIT_MB = 500

/** The limit typed in MB (0 = off), or null when it is not one the backend takes. */
export function parseLimit(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const mb = Math.round(Number(trimmed))
  return mb <= LIMIT_MAX_MB ? mb : null
}

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

/** A size for people; null when the size is not known. */
export function diskSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`
  if (bytes < GB) {
    const mb = bytes / MB
    return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`
  }
  return `${(bytes / GB).toFixed(1)} GB`
}

const known = (e: CacheEntry) => (typeof e.size_bytes === 'number' ? e.size_bytes : 0)

/** Caches that take space start ticked. */
export function initialPicks(entries: readonly CacheEntry[]): Set<string> {
  return new Set(entries.filter((e) => known(e) > 0).map((e) => e.key))
}

export function pickedBytes(entries: readonly CacheEntry[], picks: ReadonlySet<string>): number {
  return entries.filter((e) => picks.has(e.key)).reduce((sum, e) => sum + known(e), 0)
}

export function totalBytes(entries: readonly CacheEntry[]): number {
  return entries.reduce((sum, e) => sum + known(e), 0)
}

/** Ticked caches whose size the backend could not fully count (asked about before cleaning). */
export function unknownPicked(entries: readonly CacheEntry[], picks: ReadonlySet<string>): CacheEntry[] {
  return entries.filter((e) => picks.has(e.key) && (e.size_complete === false || e.size_bytes === null))
}

export function cleanOutcome(result: CleanResult): { freed: number; errors: { key: string; error: string }[] } {
  const freed = (result.cleaned ?? []).reduce((sum, c) => sum + (c.freed_bytes ?? 0), 0)
  return { freed, errors: result.errors ?? [] }
}

/** The thumbnail cache limit in force and what the cache holds now (null: not counted). */
export function thumbState(status: Pick<CacheStatus, 'settings' | 'thumbnail_cache'>): { limitMb: number; usedBytes: number | null } {
  const saved = status.settings?.thumbnail_cache_max_mb
  const stats = status.thumbnail_cache?.max_size_mb
  const limitMb = typeof saved === 'number' ? saved : typeof stats === 'number' ? stats : DEFAULT_LIMIT_MB
  const used = status.thumbnail_cache?.total_size_bytes
  return { limitMb, usedBytes: typeof used === 'number' ? used : null }
}
