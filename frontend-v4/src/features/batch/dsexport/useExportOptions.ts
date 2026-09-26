import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, unwrap } from '../../../api/client'
import type { Batch } from '../../../api/types'
import { patchBatch } from '../batchApi'
import { saveProjectSettings, useBatchProject } from '../datasetApi'
import type { ProjectSettings, TrainerConfig } from '../datasetSettings'
import { readV4Options, withExportPart, withFormat, writeV4Options, type Contracts, type ExportFormat, type FormatNote, type V4Options } from './plan'

// The export form's settings. Most live in the project (V3.5's V1 settings,
// so V3.5 exports the same way); the screen changes at once and the project
// is saved a moment after the last change, merged onto what is saved then so
// a caption rule saved meanwhile is kept. `nl_sidecar` and
// `dedupe_implications` have no place in V1 and live in the batch row.

const SAVE_AFTER_MS = 500
const waiting = new Map<number, { timer: number; next: ProjectSettings }>()

/** Save this batch's waiting export settings now (the export runs on what is saved). */
export async function flushExportOptions(batchId: number): Promise<boolean> {
  const w = waiting.get(batchId)
  if (!w) return true
  window.clearTimeout(w.timer)
  waiting.delete(batchId)
  return saveProjectSettings(batchId, (current) => withExportPart(current, w.next))
}

export interface TrainerBounds {
  repeats: { minimum: number; maximum: number }
  batch_size: { minimum: number; maximum: number }
  resolution: { minimum: number; maximum: number }
  keep_tokens: { minimum: number; maximum: number }
}

/** The verified trainers (GET /api/dataset/trainers): contract versions and number bounds. */
export function useTrainerContracts() {
  return useQuery({
    queryKey: ['dataset-trainers'],
    queryFn: async ({ signal }) => {
      const res = unwrap<{ trainers: { wire_value: TrainerConfig; contract_version: string; option_bounds: TrainerBounds }[] }>(
        await api.GET('/api/dataset/trainers', { signal }),
      )
      const versions: Contracts = {}
      const bounds: Partial<Record<TrainerConfig, TrainerBounds>> = {}
      for (const t of res.trainers) {
        versions[t.wire_value] = t.contract_version
        bounds[t.wire_value] = t.option_bounds
      }
      return { versions, bounds }
    },
    staleTime: Infinity,
  })
}

export function useExportOptions(batch: Batch) {
  const project = useBatchProject(batch)
  const contracts = useTrainerContracts()
  const saved = project.data?.project.settings ?? null
  const [draft, setDraft] = useState<ProjectSettings | null>(() => waiting.get(batch.id)?.next ?? null)
  const [notes, setNotes] = useState<FormatNote[]>([])
  const latest = useRef<ProjectSettings | null>(draft ?? saved)
  latest.current = draft ?? saved

  useEffect(() => {
    const id = batch.id
    return () => void flushExportOptions(id)
  }, [batch.id])

  const update = useCallback(
    (change: (s: ProjectSettings) => ProjectSettings) => {
      const base = latest.current
      if (!base) return
      const next = change(base)
      latest.current = next
      setDraft(next)
      const old = waiting.get(batch.id)
      if (old) window.clearTimeout(old.timer)
      const timer = window.setTimeout(() => {
        void flushExportOptions(batch.id).then((ok) => {
          // Saved (or refused and read again): the project on screen is the truth once nothing else waits.
          if (!waiting.has(batch.id)) setDraft((d) => (d === next || !ok ? null : d))
        })
      }, SAVE_AFTER_MS)
      waiting.set(batch.id, { timer, next })
    },
    [batch.id],
  )

  const setFormat = useCallback(
    (format: ExportFormat) => {
      let said: FormatNote[] = []
      update((s) => {
        const res = withFormat(s, format, contracts.data?.versions ?? {})
        said = res.notes
        return res.settings
      })
      setNotes(said)
    },
    [update, contracts.data],
  )

  // Only this form edits them: shown at once, saved through the batch queue.
  const [v4, setV4State] = useState(() => readV4Options(batch.settings))
  // Another batch brings its own (the settings object changes on every save, the batch id does not).
  useEffect(() => setV4State(readV4Options(batch.settings)), [batch.id])
  const setV4 = (change: Partial<V4Options>) => {
    const next = { ...v4, ...change }
    setV4State(next)
    void patchBatch(batch.id, { settings: writeV4Options(batch.settings, next) }, batch.revision)
  }

  return {
    view: project.data,
    loadError: project.isError ? project.error.message : null,
    settings: draft ?? saved,
    update,
    setFormat,
    notes,
    clearNotes: () => setNotes([]),
    contracts: contracts.data ?? null,
    v4,
    setV4,
  }
}

export type ExportOptions = ReturnType<typeof useExportOptions>
