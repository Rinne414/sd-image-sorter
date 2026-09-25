import { useCallback, useEffect, useRef, useState } from 'react'
import { queryClient } from '../../api/queryClient'
import type { Batch } from '../../api/types'
import { useApp } from '../../state/store'
import { batchKey, patchBatch } from './batchApi'
import { batchExportSettings, readLastUsed, rememberLastUsed, withExportSettings, type ExportSettings } from './exportSettings'

// The Name and Export steps edit one set of settings. The screen changes at
// once; the batch is saved a moment after typing stops (and when the step is
// left), through the batch queue like every other batch change. The newest
// settings are also remembered as the start for the next new batch.

const SAVE_DELAY_MS = 500
const pending = new Map<number, { timer: number; next: ExportSettings }>()

/** Save waiting settings of this batch now. */
export function flushExportSettings(batchId: number): void {
  const waiting = pending.get(batchId)
  if (!waiting) return
  window.clearTimeout(waiting.timer)
  pending.delete(batchId)
  const batch = queryClient.getQueryData<Batch>(batchKey(useApp.getState().libraryId, batchId))
  if (batch) void patchBatch(batchId, { settings: withExportSettings(batch.settings, waiting.next) })
}

function scheduleSave(batchId: number, next: ExportSettings): void {
  const waiting = pending.get(batchId)
  if (waiting) window.clearTimeout(waiting.timer)
  pending.set(batchId, { next, timer: window.setTimeout(() => flushExportSettings(batchId), SAVE_DELAY_MS) })
  rememberLastUsed(next)
}

export function useExportSettings(batch: Batch): [ExportSettings, (change: Partial<ExportSettings>) => void] {
  const [settings, setSettings] = useState(() => pending.get(batch.id)?.next ?? batchExportSettings(batch.settings, readLastUsed()))
  const latest = useRef(settings)
  useEffect(() => {
    const id = batch.id
    return () => flushExportSettings(id)
  }, [batch.id])
  const update = useCallback(
    (change: Partial<ExportSettings>) => {
      const next = { ...latest.current, ...change }
      latest.current = next
      setSettings(next)
      scheduleSave(batch.id, next)
    },
    [batch.id],
  )
  return [settings, update]
}
