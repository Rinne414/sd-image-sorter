import type { LocalJobSource } from './jobs'

// A dataset batch's check and export runs in the page that started it
// (features/batch/dsexport/exportRun.ts follows both backend jobs); the
// drawer asks it for a snapshot (read by datasetExportJob.ts) and stops it
// through it. One runs at a time: the backend exports one dataset at a time.

let source: LocalJobSource | null = null

export function setDatasetExportSource(next: LocalJobSource | null): void {
  source = next
}

export const driveDatasetExport = {
  poll: async (): Promise<unknown> => source?.snapshot() ?? null,
  cancel: async (): Promise<unknown> => source?.cancel(),
}
