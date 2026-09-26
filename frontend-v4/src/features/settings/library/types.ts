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

/** GET /api/tags/export (services/tagging/library_io.py `export_tags`): the library in use only. */
export interface TagExport {
  version?: string
  count?: number
  images?: unknown[]
}

/** POST /api/tags/import (`import_tags`). The four reasons add up to `skipped`. */
export interface TagImportResult {
  imported: number
  skipped: number
  /** Neither the path nor the file name is in this library. */
  not_found: number
  /** The file name fits several images of this library; none was changed. */
  ambiguous: number
  /** Already tagged, and "replace existing tags" was off. */
  already_tagged: number
  /** The same image listed again in the file (imported once). */
  duplicate: number
}
