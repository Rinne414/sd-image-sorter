import { useMemo } from 'react'
import { useImages } from '../../api/queries'
import type { ImagesPage } from '../../api/types'
import { EMPTY_SCOPE } from '../../lib/browseMemory'
import { parseSearch, toImageParams, type ScopeFilter } from '../../lib/searchQuery'
import { apiSort } from '../../lib/sort'
import { useApp } from '../../state/store'
import { pickFrames, type FilmFrame } from './filmPick'

// What the home film strip shows: the library's ★5 images and its newest, one
// page of each, asked for the way the library asks (the same search and sort),
// so "see all ★5" opens exactly the list the strip starts with.

/** The search the library uses for ★5: what its filter panel writes for five stars. */
export const STARRED_QUERY = '★5'

const WHOLE_LIBRARY: ScopeFilter = { generators: [], folder: null, favoritesCollectionId: null }
const NEWEST = apiSort('newest', false)
const STARRED_PARAMS = toImageParams(parseSearch(STARRED_QUERY), WHOLE_LIBRARY, NEWEST)
const NEWEST_PARAMS = toImageParams(parseSearch(''), WHOLE_LIBRARY, NEWEST)

export interface Film {
  frames: FilmFrame[]
  /** Every ★5 image in the library (the strip shows the first ones). */
  starredTotal: number
  /** Nothing loaded yet. */
  loading: boolean
  /** The library has no images at all. */
  empty: boolean
  error: Error | null
}

const firstPage = (data: { pages: ImagesPage[] } | undefined) => data?.pages[0]

export function useFilm(): Film {
  const starred = useImages(STARRED_PARAMS)
  const newest = useImages(NEWEST_PARAMS)
  const starredPage = firstPage(starred.data)
  const newestPage = firstPage(newest.data)
  const frames = useMemo(
    () => pickFrames(starredPage?.images ?? [], newestPage?.images ?? []),
    [starredPage, newestPage],
  )
  // A failed refresh keeps the frames already shown; only a strip with nothing to show reports it.
  const error = (!starredPage && starred.error) || (!newestPage && newest.error) || null
  return {
    frames,
    starredTotal: starredPage?.total ?? 0,
    loading: !error && (!starredPage || !newestPage),
    empty: newestPage !== undefined && newestPage.images.length === 0,
    error,
  }
}

/** The library with every ★5 image: the search set to ★5, the rail showing everything. */
export function seeAllStarred(): void {
  const s = useApp.getState()
  s.setScope(EMPTY_SCOPE)
  s.setQueryText(STARRED_QUERY)
  s.setPage('library')
}
