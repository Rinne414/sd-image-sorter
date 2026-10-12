import { queryClient } from '../../api/queryClient'
import { parseSearch, toImageParams, type ImageQueryParams } from '../../lib/searchQuery'
import { apiSort } from '../../lib/sort'
import { useApp, type Scope } from '../../state/store'
import type { SortBase } from '../../lib/sort'

// The gallery's current /api/images parameters, from the query line, the
// rail scope and the sort. LibraryPage renders with them; Ctrl K's random
// image and "invert" read the same thing outside React.

export interface ParamsInput {
  queryText: string
  scope: Scope
  sort: SortBase
  sortReverse: boolean
  favoritesCollectionId: number | null
}

export function libraryParams({ queryText, scope, sort, sortReverse, favoritesCollectionId }: ParamsInput): ImageQueryParams {
  return toImageParams(
    parseSearch(queryText),
    { generators: scope.generators, folder: scope.folder, favoritesCollectionId: scope.favorites ? favoritesCollectionId : null },
    apiSort(sort, sortReverse),
  )
}

/** The params the library page is showing right now. */
export function currentLibraryParams(): ImageQueryParams {
  const s = useApp.getState()
  const favorites = queryClient.getQueryData<{ collectionId: number | null }>(['favorites', s.libraryId])
  return libraryParams({ ...s, favoritesCollectionId: favorites?.collectionId ?? null })
}
