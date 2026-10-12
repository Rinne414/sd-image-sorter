import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { CacheStatus, CleanResult, DiskSettingsResult } from './types'

// What Settings › Disk & cache reads and writes. Cleaning and scheduling the
// runtime rebuild change the disk, so both are asked for by the user only.

export const DISK_KEY = ['disk-status'] as const

/** Sizes are counted on each read (a few hundred ms on a large data folder). */
export function useCacheStatus() {
  return useQuery({
    queryKey: DISK_KEY,
    queryFn: async ({ signal }) => unwrap<CacheStatus>(await api.GET('/api/disk/cache-status', { signal })),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
}

const reread = () => void queryClient.invalidateQueries({ queryKey: DISK_KEY })

/** Save the thumbnail cache limit (MB, 0 = off); the backend trims the cache to it at once. */
export async function saveThumbnailLimit(mb: number): Promise<DiskSettingsResult> {
  const res = unwrap<DiskSettingsResult>(await api.POST('/api/disk/settings', { body: { thumbnail_cache_max_mb: mb } }))
  reread()
  return res
}

export async function cleanCaches(keys: string[]): Promise<CleanResult> {
  try {
    return unwrap<CleanResult>(await api.POST('/api/disk/cleanup', { body: { keys } }))
  } finally {
    reread()
  }
}

/** Leave the marker that makes the next launcher start rebuild the light Python runtime. */
export async function scheduleRuntimeRebuild(): Promise<void> {
  unwrap(await api.POST('/api/disk/runtime/rebuild-core'))
  reread()
}
