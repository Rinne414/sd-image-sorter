// What an import (GET /api/scan/progress) says beyond its counts: that it has
// shown no progress for a while (the diagnostics card), and which images it
// left alone because they belong to another library (so they can be moved
// here). Pure: progress.ts reads it into the scan job.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export interface ScanStall {
  seconds: number
  step: string
  item: string | null
  /** Images still waiting for their generation details. */
  pending: number
  done: number
  total: number
  /** The support log exists and can be copied or opened. */
  logReady: boolean
}

export interface ScanExtras {
  stall: ScanStall | null
  otherLibrary: { count: number; paths: string[] }
}

function readStall(raw: Raw): ScanStall | null {
  if (raw.attention_required !== true) return null
  const details = num(raw.metadata_total) > 0
  return {
    seconds: Math.round(num(raw.stalled_seconds)),
    step: str(raw.step) || str(raw.status),
    item: str(raw.current_item) || null,
    pending: num(raw.metadata_pending),
    done: details ? num(raw.metadata_processed) : num(raw.processed),
    total: details ? num(raw.metadata_total) : num(raw.total),
    logReady: raw.diagnostics_available === true,
  }
}

export function readScanExtras(raw: Raw): ScanExtras {
  const paths = Array.isArray(raw.skipped_other_library_paths)
    ? raw.skipped_other_library_paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : []
  return { stall: readStall(raw), otherLibrary: { count: num(raw.skipped_other_library), paths } }
}
