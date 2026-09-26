import { create } from 'zustand'
import { tokenValue } from '../../../lib/queryEdit'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { withArtist } from './artistModel'
import { art } from './artistText'

// What the style page shows (kept while the user is elsewhere): the artist
// open on the right, the list tab, and the images sent here with "送到工具".

export type ListTab = 'confident' | 'candidates'

interface ArtistView {
  selected: string | null
  tab: ListTab
  /** Images sent with "送到工具 ▸ 画风识别" (null: none). */
  sent: number[] | null
}

export const useArtistView = create<ArtistView>(() => ({ selected: null, tab: 'confident', sent: null }))

export const selectArtist = (selected: string | null) => useArtistView.setState({ selected })
export const setListTab = (tab: ListTab) => useArtistView.setState({ tab })
export const setSent = (sent: number[] | null) => useArtistView.setState({ sent })

/** Show this artist's images in the library (and put `id` on the card when one was clicked). */
export function viewInLibrary(name: string, id: number | null = null): void {
  const s = useApp.getState()
  const text = withArtist(s.queryText, name)
  s.setQueryText(text)
  if (id !== null) s.inspect(id)
  if (s.lightboxId !== null) s.closeLightbox()
  s.setPage('library')
  useToasts.getState().push(art('artist.filtered', { query: `artist:${tokenValue(name)}` }))
}
