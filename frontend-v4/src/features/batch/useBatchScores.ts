import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useApp } from '../../state/store'
import { imagesByIds } from '../similar/similarApi'
import type { Entry } from './entries'
import { idChunks, scoreMap } from './hoverPlace'

/** The by-ids endpoint's most per request. */
const BY_IDS_CHUNK = 2000
const NONE: ReadonlyMap<number, number> = new Map()

/** Aesthetic scores of the batch's Library images that have one (a badge on the Order step's tiles). */
export function useBatchScores(entries: readonly Entry[]): ReadonlyMap<number, number> {
  const libraryId = useApp((s) => s.libraryId)
  const ids = useMemo(() => entries.flatMap((entry) => (entry.imageId === null ? [] : [entry.imageId])).sort((a, b) => a - b), [entries])
  const query = useQuery({
    queryKey: ['batch-scores', libraryId, ids.join(',')],
    enabled: ids.length > 0,
    queryFn: async () => scoreMap((await Promise.all(idChunks(ids, BY_IDS_CHUNK).map(imagesByIds))).flat()),
    staleTime: 60_000,
  })
  return query.data ?? NONE
}
