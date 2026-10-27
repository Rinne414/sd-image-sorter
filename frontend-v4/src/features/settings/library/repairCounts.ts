// What Settings › Library › Repair prompts and text can work on, read from
// GET /api/metadata/health: how many images have no text at all (what a
// recovery can still find) and how many are ComfyUI images (what a re-read
// walks). Pure, so the numbers are tested.

export interface RepairCounts {
  /** Readable images with neither a prompt nor a caption. */
  missingText: number
  /** Readable ComfyUI images. */
  comfy: number
}

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function readRepairCounts(payload: unknown): RepairCounts {
  const raw = (payload && typeof payload === 'object' ? payload : {}) as Raw
  const totals = (raw.totals && typeof raw.totals === 'object' ? raw.totals : {}) as Raw
  const generators = Array.isArray(raw.generators) ? raw.generators : []
  const comfy = generators.find((g): g is Raw => !!g && typeof g === 'object' && (g as Raw).generator === 'comfyui')
  return { missingText: num(totals.missing_text), comfy: num(comfy?.total) }
}
