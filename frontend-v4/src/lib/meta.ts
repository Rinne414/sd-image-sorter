// Read the generation parameters the backend parsed out of each image's
// metadata (metadata_json._parsed) into one shape for every generator.

export interface CharacterPrompt {
  index: number
  prompt: string
  negative: string
}

export interface GenerationInfo {
  seed: string | null
  steps: string | null
  cfg: string | null
  sampler: string | null
  scheduler: string | null
  size: string | null
  denoise: string | null
  model: string | null
  loras: string[]
  characters: CharacterPrompt[]
  isImg2img: boolean
  /** Every other parameter, for the "more" list. */
  extra: [string, string][]
}

const KNOWN = new Set([
  'seed',
  'steps',
  'cfg_scale',
  'sampler',
  'schedule_type',
  'noise_schedule',
  'scheduler',
  'size',
  'denoising_strength',
  'model',
  'model_hash',
])

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return JSON.stringify(v)
}

function parseJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function parseLoras(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []
  } catch {
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
  }
}

export function shortModelName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.(safetensors|ckpt|pt|pth|gguf|sft)$/i, '')
}

export function readGeneration(input: {
  metadata_json: string | null
  checkpoint: string | null
  loras: string | null
  width: number | null
  height: number | null
}): GenerationInfo {
  const meta = parseJson(input.metadata_json)
  const parsed = (meta._parsed ?? {}) as Record<string, unknown>
  const params = (parsed.generation_params ?? {}) as Record<string, unknown>

  const characters: CharacterPrompt[] = Array.isArray(parsed.character_prompts)
    ? (parsed.character_prompts as Record<string, unknown>[])
        .map((c, i) => ({
          index: typeof c.index === 'number' ? c.index : i,
          prompt: str(c.prompt) ?? '',
          negative: str(c.negative_prompt) ?? '',
        }))
        .filter((c) => c.prompt)
    : []

  const extra: [string, string][] = []
  for (const [k, v] of Object.entries(params)) {
    if (KNOWN.has(k)) continue
    const s = str(v)
    if (s !== null) extra.push([k, s])
  }

  const size =
    str(params.size) ?? (input.width && input.height ? `${input.width}x${input.height}` : null)

  return {
    seed: str(params.seed),
    steps: str(params.steps),
    cfg: str(params.cfg_scale),
    sampler: str(params.sampler),
    scheduler: str(params.schedule_type) ?? str(params.noise_schedule) ?? str(params.scheduler),
    size: size ? size.replace('x', '×') : null,
    denoise: str(params.denoising_strength),
    model: input.checkpoint ?? str(params.model),
    loras: parseLoras(input.loras),
    characters,
    isImg2img: parsed.is_img2img === true,
    extra,
  }
}

/** A1111-style parameter block, the format most tools can paste back in. */
export function toParameterText(prompt: string | null, negative: string | null, g: GenerationInfo): string {
  const lines: string[] = []
  if (prompt) lines.push(prompt)
  if (negative) lines.push(`Negative prompt: ${negative}`)
  const parts: string[] = []
  if (g.steps) parts.push(`Steps: ${g.steps}`)
  if (g.sampler) parts.push(`Sampler: ${g.sampler}`)
  if (g.scheduler) parts.push(`Schedule type: ${g.scheduler}`)
  if (g.cfg) parts.push(`CFG scale: ${g.cfg}`)
  if (g.seed) parts.push(`Seed: ${g.seed}`)
  if (g.size) parts.push(`Size: ${g.size.replace('×', 'x')}`)
  if (g.model) parts.push(`Model: ${shortModelName(g.model)}`)
  if (g.denoise) parts.push(`Denoising strength: ${g.denoise}`)
  if (parts.length) lines.push(parts.join(', '))
  return lines.join('\n')
}
