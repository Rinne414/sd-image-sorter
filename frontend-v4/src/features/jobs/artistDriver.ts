import { api, unwrap } from '../../api/client'
import { readProgress } from './progress'

// Polls and stops style (artist) identification for the Jobs drawer (read by
// artistJob.ts). The polls leave out the per-image results, which grow with
// every image; the run's summary reads them once at the end.

type Raw = Record<string, unknown>

export const driveArtist = {
  poll: async (): Promise<unknown> =>
    unwrap(await api.GET('/api/artists/batch-progress', { params: { query: { include_results: false } } })),
  cancel: async (): Promise<unknown> => unwrap(await api.POST('/api/artists/batch-cancel')),
}

/** A run already going when V4 opened (a reload, or V3.5 started it). */
export function adoptArtist(raw: Raw) {
  if (raw.running !== true) return null
  const progress = readProgress('artist', raw)
  return { kind: 'artist' as const, progress, count: progress.total }
}
