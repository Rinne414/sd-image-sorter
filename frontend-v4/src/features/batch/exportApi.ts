import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { api, ApiError, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import type { Batch, BatchItem } from '../../api/types'
import { useApp } from '../../state/store'
import { batchKey, enqueue } from './batchApi'
import type { exportBody, namesBody } from './exportSettings'
import type { NamePreview } from './names'

// Reads and the export of the Order / Name / Export steps. The name preview
// and the export run in the batch's queue, after every reorder or name change
// still on its way, so they always see the order and names on screen.

export interface ExportedFile {
  image_id: number
  position: number
  filename: string
  output_name: string
  output_path: string
  source: 'censored' | 'original'
  used_censored: boolean
  metadata_option: string
  generation_data_removed: boolean
  watermarked: boolean
  overwrote_existing: boolean
  reconciled_image_id: number | null
  warnings: string[]
}

export interface ExportResult {
  success: boolean
  batch_id: number
  output_folder: string
  exported: ExportedFile[]
  skipped: { image_id: number; filename: string; reason: string }[]
  errors: { image_id: number | null; filename: string; error: string }[]
  caption_file: string | null
}

/** Why the server refused an export (nothing was written). */
export type ExportFailure =
  | { kind: 'missing'; ids: number[] }
  | { kind: 'exists'; names: string[] }
  | { kind: 'duplicates'; names: string[] }
  | { kind: 'sources'; names: string[] }
  | { kind: 'template'; token: string }
  | { kind: 'other'; message: string }

const list = (body: unknown, key: string): unknown[] => {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : null
  return Array.isArray(value) ? value : []
}
const field = (entry: unknown, key: string): unknown => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[key] : undefined)
const strings = (values: unknown[]): string[] => values.filter((v): v is string => typeof v === 'string')

export function exportFailure(error: unknown): ExportFailure {
  if (!(error instanceof ApiError)) return { kind: 'other', message: (error as Error)?.message ?? String(error) }
  const body = error.body
  switch (error.code) {
    case 'batch_export_missing_censored':
      return { kind: 'missing', ids: list(body, 'missing').map((m) => field(m, 'image_id')).filter((id): id is number => typeof id === 'number') }
    case 'batch_export_files_exist':
      return { kind: 'exists', names: strings(list(body, 'existing')) }
    case 'batch_export_duplicate_names':
      return { kind: 'duplicates', names: strings(list(body, 'duplicates').map((d) => field(d, 'output_name'))) }
    case 'batch_export_sources_missing':
      return { kind: 'sources', names: strings(list(body, 'missing').map((m) => field(m, 'filename'))) }
    case 'batch_export_name_template_invalid':
      return { kind: 'template', token: String(field(body, 'token') ?? '') }
    default:
      return { kind: 'other', message: error.message }
  }
}

export type ExportRun =
  | { state: 'running'; count: number; started: number }
  | { state: 'done'; result: ExportResult }
  | { state: 'failed'; failure: ExportFailure }

/** The export of each batch, kept outside the page: leaving and coming back shows it running or its result. */
export const useExportRuns = create<{ runs: Record<number, ExportRun> }>(() => ({ runs: {} }))

function setRun(batchId: number, run: ExportRun | null): void {
  useExportRuns.setState((s) => {
    const runs = { ...s.runs }
    if (run) runs[batchId] = run
    else delete runs[batchId]
    return { runs }
  })
}

export const clearExportRun = (batchId: number) => setRun(batchId, null)

/** Export the batch; a second press while it runs does nothing. */
export async function runExport(batchId: number, count: number, body: ReturnType<typeof exportBody>): Promise<void> {
  if (useExportRuns.getState().runs[batchId]?.state === 'running') return
  setRun(batchId, { state: 'running', count, started: Date.now() })
  try {
    const result = await enqueue(batchId, async () =>
      unwrap<ExportResult>(await api.POST('/api/batches/{batch_id}/export', { params: { path: { batch_id: batchId } }, body })),
    )
    setRun(batchId, { state: 'done', result })
    if (result.exported.some((file) => file.reconciled_image_id !== null)) void queryClient.invalidateQueries({ queryKey: ['images'] })
  } catch (error) {
    const failure = exportFailure(error)
    // A copy that went away elsewhere: read the batch again so the list is right.
    if (failure.kind === 'missing') void queryClient.invalidateQueries({ queryKey: batchKey(useApp.getState().libraryId, batchId) })
    setRun(batchId, { state: 'failed', failure })
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return settled
}

const PREVIEW_DELAY_MS = 250

/** The final file names from the server; `stale` while typing or while a newer answer is on its way. */
export function useNamePreview(batch: Batch, body: ReturnType<typeof namesBody>, enabled = true) {
  const library = useApp((s) => s.libraryId)
  const key = JSON.stringify(body)
  const settledKey = useDebounced(key, PREVIEW_DELAY_MS)
  const items = batch.items.map((i) => `${i.image_id}:${i.output_name ?? ''}:${i.has_censored ? 1 : 0}`).join(',')
  const query = useQuery({
    queryKey: ['batch-names', library, batch.id, settledKey, items],
    queryFn: () =>
      enqueue(batch.id, async () =>
        unwrap<NamePreview>(
          await api.POST('/api/batches/{batch_id}/export/names', {
            params: { path: { batch_id: batch.id } },
            body: JSON.parse(settledKey) as ReturnType<typeof namesBody>,
          }),
        ),
      ),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  })
  return { preview: query.data, stale: key !== settledKey || query.isPlaceholderData || query.isFetching, error: query.error }
}

/**
 * An object URL of the item's censored copy, fetched once the tile is on
 * screen. The request names the batch's library (an <img> could not send the header).
 */
export function useCensoredUrl(batch: Batch, item: BatchItem, visible: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)
  const wanted = visible && item.has_censored
  const version = item.censored_at
  useEffect(() => {
    if (!wanted) return
    let alive = true
    let made: string | null = null
    void fetch(`/api/batches/${batch.id}/items/${item.image_id}/censored`, { headers: { 'X-SD-Library-Id': batch.library_id } })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!alive || !blob) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
      setUrl(null)
    }
  }, [wanted, batch.id, batch.library_id, item.image_id, version])
  return wanted ? url : null
}
