import type { InfiniteData } from '@tanstack/react-query'
import { queryClient } from './queryClient'
import type { ImageSummary, ImagesPage } from './types'

/** Every image any gallery query has loaded, by id. */
function loadedIndex(): Map<number, ImageSummary> {
  const index = new Map<number, ImageSummary>()
  for (const [, data] of queryClient.getQueriesData<InfiniteData<ImagesPage>>({ queryKey: ['images'] })) {
    for (const page of data?.pages ?? []) for (const img of page.images) index.set(img.id, img)
  }
  return index
}

/** An image the gallery has already loaded, found by id (null when not loaded). */
export function findLoadedImage(id: number): ImageSummary | null {
  return loadedIndex().get(id) ?? null
}

/** Filenames of the first `max` ids that are loaded, in the given order. */
export function loadedNames(ids: readonly number[], max: number): string[] {
  const index = loadedIndex()
  const names: string[] = []
  for (const id of ids) {
    if (names.length >= max) break
    const img = index.get(id)
    if (img) names.push(img.filename)
  }
  return names
}
