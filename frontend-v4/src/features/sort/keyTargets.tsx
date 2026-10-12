import { useFavorites } from '../../api/queries'
import { useT } from '../../i18n'
import { folderName } from '../../lib/paths'
import type { KeyTarget } from './sortSession'

// A sort key that adds the image to Favorites instead of moving its file
// (V3.5: a key could point at a folder or a collection). The key is a
// collection key on the built-in Favorites collection.

/** Names what a key sends images to (a folder, Favorites, or a collection V3.5 set), and knows the Favorites collection. */
export function useTargetName() {
  const t = useT()
  const favoritesId = useFavorites().data?.collectionId ?? null
  const name = (target: KeyTarget | null): string => {
    if (!target) return t('sort.slot.unset')
    if (target.kind === 'folder') return folderName(target.path)
    if (target.kind === 'favorites') return t('rail.favorites')
    return t('sort.slot.collectionShort', { id: target.id })
  }
  return { favoritesId, name }
}
