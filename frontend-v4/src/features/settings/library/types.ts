// What Settings › Library reads. These routes have no response_model, so the
// shapes are written here from the backend code they come from.

/** GET /api/library-roots → roots (services/image/gallery.py `get_library_roots`). */
export interface LibraryRoot {
  id: number
  /** Forward slashes, as registered when the folder was imported. */
  path: string
  /** Indexed images under the folder (its subfolders included). */
  image_count: number
  /** false: the folder is no longer on disk. */
  exists: boolean
  last_scanned_at: string | null
}

export interface LibraryRootsResponse {
  roots: LibraryRoot[]
}

/** GET /api/tags/export (services/tagging/library_io.py `export_tags`). */
export interface TagExport {
  version?: string
  count?: number
  images?: unknown[]
}

/** POST /api/tags/import */
export interface TagImportResult {
  imported: number
  skipped: number
}
