import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { plt } from './plText'

// Leaving 提示词助手 for the library: with a new search text ("筛到图库"),
// or with one image open on the card.

/** Put this search text in the library's search line and show the library. */
export function showInLibrary(text: string, what: string): void {
  const s = useApp.getState()
  s.setQueryText(text)
  if (s.lightboxId !== null) s.closeLightbox()
  s.setPage('library')
  useToasts.getState().push(plt('pl.filtered', { what }))
}

/** The library with this image on the card (whatever the search shows). */
export function openInLibrary(id: number): void {
  const s = useApp.getState()
  s.inspect(id)
  s.setPage('library')
}
