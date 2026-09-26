import type { Batch } from '../../api/types'
import { useNamePreview } from '../batch/exportApi'
import { namesBody } from '../batch/exportSettings'
import { useNameStamp } from '../batch/nameStamp'
import { useExportSettings } from '../batch/useExportSettings'

/**
 * The file name the export writes for this image now, as the server computes
 * it for the Name step (its template, the numbering and any override); null
 * while it is not known.
 */
export function useFinalName(batch: Batch, imageId: number): string | null {
  const [settings] = useExportSettings(batch)
  const stamp = useNameStamp()
  const hasTemplate = settings.name_template.trim() !== ''
  const { preview } = useNamePreview(batch, namesBody(settings, 'block', stamp), hasTemplate)
  return preview?.items.find((i) => i.image_id === imageId)?.output_name ?? null
}
