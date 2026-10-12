import { api, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { SaveFormat, WarningCode } from './metadataForm'

// POST /api/image-metadata/save-edited: a copy with edited generation details,
// or (a library image, confirmed) the original file itself.

export interface SaveEditedResult {
  output_path: string
  format: SaveFormat
  /** English, for V3.5. */
  warnings: string[]
  /** The same warnings as codes, in the same order. */
  warning_codes?: WarningCode[]
}

export interface SaveRequest {
  sourcePath: string
  outputPath: string
  format: SaveFormat
  metadata: Record<string, string | number>
  /** Replace a file that is already there (the user said yes). */
  overwrite: boolean
}

export async function saveEdited(r: SaveRequest): Promise<SaveEditedResult> {
  return unwrap<SaveEditedResult>(
    await api.POST('/api/image-metadata/save-edited', {
      body: { source_path: r.sourcePath, output_path: r.outputPath, format: r.format, metadata: r.metadata, allow_overwrite: r.overwrite },
    }),
  )
}

/** A library image's file changed: the backend re-read it; the card, tiles and search see the new details. */
export function refreshLibraryImage(id: number): void {
  void queryClient.invalidateQueries({ queryKey: ['image', id] })
  for (const key of ['images', 'suggest', 'image-count']) void queryClient.invalidateQueries({ queryKey: [key] })
}

/** A copy may have landed on a file the library already holds (the backend re-read that one). */
export function refreshLibrary(): void {
  for (const key of ['image', 'images', 'suggest', 'image-count']) void queryClient.invalidateQueries({ queryKey: [key] })
}

/** Read the file's generation details again (when the backend's own refresh after the save failed). */
export async function reparseImage(id: number): Promise<void> {
  unwrap(await api.POST('/api/images/{image_id}/reparse', { params: { path: { image_id: id } } }))
  refreshLibraryImage(id)
}
