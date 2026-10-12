import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import { useApp } from '../../../state/store'
import type { ArtistDiagnostics, ArtistImagesPage, ArtistStats, Vocabulary } from './types'

// The style tool's reads, and clearing its results. A finished run refreshes
// 'artist-stats' and 'artist-images' (jobs.ts REFRESH_KEYS).

/** Previews per page of one artist's images (V3.5 used the same). */
export const PREVIEW_PAGE = 120

/** The five numbers and both artist lists, for the library on screen. */
export function useArtistStats() {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['artist-stats', libraryId],
    queryFn: async ({ signal }) => unwrap<ArtistStats>(await api.GET('/api/artists/stats', { signal })),
    staleTime: 30_000,
  })
}

/** One artist's images, most confident first, a page at a time. */
export function useArtistImages(name: string | null) {
  return useInfiniteQuery({
    queryKey: ['artist-images', name],
    enabled: name !== null,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) =>
      unwrap<ArtistImagesPage>(
        await api.GET('/api/artists/images/{artist_name}', {
          params: { path: { artist_name: name ?? '' }, query: { limit: PREVIEW_PAGE, offset: pageParam } },
          signal,
        }),
      ),
    getNextPageParam: (last) => (last.has_more ? last.offset + last.images.length : undefined),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

/** Whether the style model can run (missing packages); it never loads the model. */
export function useArtistDiagnostics() {
  return useQuery({
    queryKey: ['artist-diagnostics'],
    queryFn: async ({ signal }) => unwrap<ArtistDiagnostics>(await api.GET('/api/artists/diagnostics', { signal })),
    staleTime: 60_000,
  })
}

/** Which of these names the loaded model can ever answer with. */
export async function checkVocabulary(names: readonly string[]): Promise<Vocabulary> {
  return unwrap<Vocabulary>(await api.GET('/api/artists/vocabulary', { params: { query: { name: [...names] } } }))
}

/** Remove every style result (the images stay). */
export async function clearResults(): Promise<void> {
  unwrap(await api.DELETE('/api/artists/clear'))
  for (const key of ['artist-stats', 'artist-images', 'images', 'image-count']) void queryClient.invalidateQueries({ queryKey: [key] })
}
