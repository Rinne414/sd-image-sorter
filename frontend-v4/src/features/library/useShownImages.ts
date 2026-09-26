import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useImages } from '../../api/queries'
import type { ImageSummary } from '../../api/types'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { useRankedImages } from '../similar/similarApi'
import { queryKeyOf, useSimilar, type SimilarQuery } from '../similar/similarStore'

// What the grid shows: the filter's result, or — while a similarity search is
// on — the images ranked by likeness. Everything that works on "the images in
// the grid" (keys, lightbox, picking all) takes it from here.

export interface Shown {
  images: ImageSummary[]
  /** The filter's size; null while ranked by likeness (the ranking has no size). */
  total: number | null
  hasMore: boolean
  fetchingMore: boolean
  fetchMore: () => void
  stale: boolean
  gridKey: string
  similar: SimilarQuery | null
  /** Likeness per image while ranked. */
  scores: ReadonlyMap<number, number> | undefined
  loading: boolean
  error: Error | null
  empty: boolean
  retry: () => void
}

export function useShownImages(params: ImageQueryParams): Shown {
  const similar = useSimilar((s) => s.query)
  const filter = useImages(params)
  const ranked = useRankedImages(similar)
  const filterImages = useMemo(() => filter.data?.pages.flatMap((p) => p.images) ?? [], [filter.data])
  const rankedImages = useMemo(() => ranked.data?.pages.flatMap((p) => p.images) ?? [], [ranked.data])
  const scores = useMemo(() => new Map(rankedImages.map((img) => [img.id, img.similarity])), [rankedImages])
  const fetchFilter = useCallback(() => void filter.fetchNextPage(), [filter])
  const fetchRanked = useCallback(() => void ranked.fetchNextPage(), [ranked])
  const gridKey = JSON.stringify(params)

  // Changing the filter means the user went back to filtering.
  const lastKey = useRef(gridKey)
  useEffect(() => {
    if (lastKey.current !== gridKey && useSimilar.getState().query) useSimilar.getState().clear()
    lastKey.current = gridKey
  }, [gridKey])

  if (similar) {
    return {
      images: rankedImages,
      total: null,
      hasMore: ranked.hasNextPage,
      fetchingMore: ranked.isFetchingNextPage,
      fetchMore: fetchRanked,
      stale: false,
      gridKey: `similar:${queryKeyOf(similar)}`,
      similar,
      scores,
      loading: ranked.isPending,
      error: ranked.error,
      empty: ranked.isSuccess && rankedImages.length === 0,
      retry: () => void ranked.refetch(),
    }
  }
  return {
    images: filterImages,
    total: filter.data?.pages[0]?.total ?? null,
    hasMore: filter.hasNextPage,
    fetchingMore: filter.isFetchingNextPage,
    fetchMore: fetchFilter,
    stale: filter.isPlaceholderData,
    gridKey,
    similar: null,
    scores: undefined,
    loading: filter.isPending,
    error: filter.error,
    empty: filter.isSuccess && filterImages.length === 0,
    retry: () => void filter.refetch(),
  }
}
