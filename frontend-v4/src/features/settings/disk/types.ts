// GET /api/disk/cache-status and what the disk routes answer (services/disk_service.py).
// These routes have no response_model, so the shapes are written here.

/** One folder: a cache that can be cleaned, or one that is kept. */
export interface CacheEntry {
  key: string
  label_key: string
  path: string
  /** null when the backend could not count it. */
  size_bytes: number | null
  size_complete: boolean
  exists?: boolean
}

export interface ThumbnailCacheStats {
  total_size_bytes?: number | null
  max_size_mb?: number
}

export interface RuntimeEnvironment {
  venv_size_bytes?: number
  rebuild_core_pending?: boolean
}

export interface LibraryIndexEntry {
  id: string
  name: string
  is_default: boolean
  image_count: number
}

export interface LibraryIndex {
  db_path: string
  db_size_bytes: number
  total_images: number
  libraries: LibraryIndexEntry[]
}

export interface CacheStatus {
  safe_to_clean: CacheEntry[]
  preserved: CacheEntry[]
  settings?: { thumbnail_cache_max_mb?: number }
  thumbnail_cache?: ThumbnailCacheStats
  runtime_environment?: RuntimeEnvironment
  library_index?: LibraryIndex
}

/** POST /api/disk/settings */
export interface DiskSettingsResult {
  settings?: { thumbnail_cache_max_mb?: number }
  thumbnail_cache?: ThumbnailCacheStats
  limit_cleanup?: { freed_bytes?: number }
}

/** POST /api/disk/cleanup */
export interface CleanResult {
  cleaned?: { key: string; freed_bytes?: number }[]
  errors?: { key: string; error: string }[]
}
