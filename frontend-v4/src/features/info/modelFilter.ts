import { modelFilterValue } from '../../lib/imageInfo'
import { onlyWith } from '../../lib/queryEdit'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'

/**
 * Clicked a model or LoRA on the generation card: the library shows the
 * images made with it. The query text changes the way the filter panel changes
 * it (the query stays the only filter state); the big image closes and a batch
 * page gives way to the library, where the result is.
 */
export function filterByModel(kind: 'checkpoint' | 'lora', name: string): void {
  const value = modelFilterValue(name)
  if (!value) return
  const s = useApp.getState()
  s.setQueryText(onlyWith(s.queryText, kind, value))
  if (s.lightboxId !== null) s.closeLightbox()
  if (s.page !== 'library') s.setPage('library')
  useToasts.getState().push(tr('info.filtered', { value }), 'info')
}
