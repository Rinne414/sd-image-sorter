import { api, unwrap } from '../../api/client'
import type { components } from '../../api/schema'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { toSelectionBody } from '../../lib/selectionBody'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'

type SelectionIdsBody = components['schemas']['SelectionIdsRequest']

/** Every image the filter matches, from the server (not only the loaded pages). */
export async function matchingIds(params: ImageQueryParams): Promise<number[]> {
  // Filters left out of the body take the server's defaults, same as the gallery list.
  const body = toSelectionBody(params) as unknown as SelectionIdsBody
  return unwrap<{ image_ids: number[] }>(await api.POST('/api/images/selection-ids', { body })).image_ids
}

/**
 * Invert within the current filter (V3.5 "反选当前筛选"): what the filter
 * matches and is not picked becomes the picks; picks outside it are dropped.
 */
export async function invertPicks(params: ImageQueryParams): Promise<boolean> {
  try {
    const ids = await matchingIds(params)
    const s = useApp.getState()
    const picked = new Set(s.selection)
    s.setSelection(ids.filter((id) => !picked.has(id)))
    return true
  } catch (error) {
    useToasts.getState().push(tr('lib.sel.invertFailed', { reason: (error as Error).message }), 'error')
    return false
  }
}
