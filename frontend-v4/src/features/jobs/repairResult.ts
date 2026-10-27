// What a finished metadata repair found, read from its bulk job's `result`
// (POST /api/metadata/reparse): recovering missing text counts prompts and
// captions found, re-reading ComfyUI prompts counts the ones that changed.
// Pure, so the numbers Settings reports can be tested.

type Raw = Record<string, unknown>

export type RepairResult =
  | { kind: 'recover'; recovered: number; captions: number; still: number }
  | { kind: 'comfy'; changed: number; unchanged: number; kept: number; missing: number }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The result of a recovery (`recover`) or a ComfyUI re-read (`comfy`); null while the job has none yet. */
export function readRepairResult(kind: RepairResult['kind'], result: unknown): RepairResult | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Raw
  if (kind === 'comfy') {
    if (!('changed' in r) && !('unchanged' in r)) return null
    return { kind, changed: num(r.changed), unchanged: num(r.unchanged), kept: num(r.kept), missing: num(r.missing_source) }
  }
  if (!('recovered' in r) && !('captions_recovered' in r)) return null
  // Files that are gone count as still without text: nothing could be read from them.
  return { kind, recovered: num(r.recovered), captions: num(r.captions_recovered), still: num(r.still_missing) + num(r.missing_source) }
}
