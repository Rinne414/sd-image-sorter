import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useImageDetail } from '../../../api/queries'
import type { ImageDetailResponse } from '../../../api/types'
import { parseUpload } from '../intake/intakeFiles'
import { createSourceStore, type ImageSource } from '../intake/sourceStore'
import { fromDetail, fromParse, readRecord, type ParseResult, type ReaderView } from './readerAdapter'

// The image on the Reader (intake/sourceStore.ts): a file brought in, or a
// library image read from the database by id.

export type ReaderSource = ImageSource

const reader = createSourceStore()

export const useReader = reader.useSource
export const openUpload = reader.openUpload
export const openLibraryImage = reader.openLibraryImage
export const clearReader = reader.clear

/** The shown image read, whichever way it came in. */
export interface ReaderData {
  view: ReaderView | null
  loading: boolean
  error: Error | null
  /** The upload's parse (its kept copy is what saving reads from). */
  parse: ParseResult | null
  detail: ImageDetailResponse | null
}

export function useReaderData(source: ReaderSource | null): ReaderData {
  const upload = source?.kind === 'upload' ? source : null
  const libraryId = source?.kind === 'library' ? source.id : null
  const parsed = useQuery({
    queryKey: ['reader-parse', upload?.seq ?? 0],
    enabled: upload !== null,
    queryFn: ({ signal }) => parseUpload((upload as { file: File }).file, signal),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  })
  const detail = useImageDetail(libraryId)
  const parseData = upload ? (parsed.data ?? null) : null
  const detailData = libraryId !== null ? (detail.data ?? null) : null
  // Read once per answer: the editor starts over whenever this changes.
  const view = useMemo(() => {
    if (parseData) return readRecord(fromParse(parseData))
    if (detailData) return readRecord(fromDetail(detailData.image))
    return null
  }, [parseData, detailData])
  if (upload) return { view, loading: parsed.isPending, error: parsed.error, parse: parseData, detail: null }
  if (libraryId !== null) return { view, loading: detail.isPending, error: detail.error, parse: null, detail: detailData }
  return { view: null, loading: false, error: null, parse: null, detail: null }
}
