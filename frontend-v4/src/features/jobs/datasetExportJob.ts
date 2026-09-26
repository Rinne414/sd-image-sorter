import type { JobFailure, JobProgress } from './progress'

// Reads a dataset batch's "check and export" for the Jobs drawer: one job
// that runs the backend's check (POST /api/dataset/readiness/start) and then,
// when nothing stops it, the export (POST /api/dataset/export/start), both
// bulk jobs. The page that started it follows both and reports one snapshot
// (features/batch/dsexport/exportRun.ts); pure: datasetExportDriver.ts asks.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])

function failures(list: unknown): JobFailure[] {
  return rows(list).map((r) => ({ id: null, name: str(r.name), reason: str(r.reason) || 'Failed' }))
}

export function readDatasetExport(base: JobProgress, raw: Raw): JobProgress {
  const failed = failures(raw.failures)
  return {
    ...base,
    current: num(raw.current),
    total: num(raw.total),
    succeeded: num(raw.exported),
    failedCount: Math.max(num(raw.failed), failed.length),
    failures: failed,
  }
}
