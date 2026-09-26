// The rest of what an image's metadata says, beyond the prompt and the key
// parameters (meta.ts): img2img, Civitai resources, ComfyUI prompt nodes, the
// model hash, LoRA strengths and the other models of a workflow. Read from
// metadata_json._parsed as the backend's metadata parser wrote it.

export interface Img2Img {
  /** 'img2img' | 'inpaint' | 'hires fix' | 'latent upscale', or the parser's own word; null when not recorded. */
  kind: string | null
  denoise: string | null
  noise: string | null
  /** Anything else the parser recorded. */
  other: [string, string][]
}

export interface CivitaiResource {
  name: string
  version: string | null
  weight: string | null
  /** From the AIR: 'lora' | 'checkpoint' | 'embedding' ... */
  kind: string | null
  /** Only http(s) links; anything else is dropped. */
  url: string | null
}

export interface PromptNode {
  id: string
  type: string
  role: 'positive' | 'negative' | null
  text: string
}

export type ModelGroupId = 'checkpoint' | 'unet' | 'vae' | 'clip' | 'diffusion' | 'other' | 'detector' | 'guessLora' | 'guessDetector'

export interface ModelGroup {
  group: ModelGroupId
  names: string[]
}

export interface ImageInfo {
  img2img: Img2Img | null
  civitai: CivitaiResource[]
  nodes: PromptNode[]
  modelHash: string | null
  /** The workflow's models besides the main one, grouped as the parser found them. */
  otherModels: ModelGroup[]
  /** A LoRA's strength from its loader ("0.8", or "model / clip" when they differ); null when not recorded. */
  loraWeight: (name: string) => string | null
}

type Raw = Record<string, unknown>

const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])

function text(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.round(v * 1000) / 1000)
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'boolean') return String(v)
  return null
}

function parsedOf(raw: string | null): Raw {
  if (!raw) return {}
  try {
    return obj(obj(JSON.parse(raw))._parsed)
  } catch {
    return {}
  }
}

function readImg2Img(parsed: Raw): Img2Img | null {
  if (parsed.is_img2img !== true) return null
  const info = obj(parsed.img2img_info)
  const other: [string, string][] = []
  for (const [k, v] of Object.entries(info)) {
    if (k === 'source' || k === 'denoising_strength' || k === 'noise') continue
    const value = text(v)
    if (value !== null) other.push([k, value])
  }
  return { kind: text(info.source), denoise: text(info.denoising_strength), noise: text(info.noise), other }
}

const httpUrl = (v: unknown) => (typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : null)

/** urn:air:sdxl:lora:civitai:123@456 → 'lora'. */
const airKind = (air: unknown) => (typeof air === 'string' ? (air.split(':')[3] ?? '').toLowerCase() || null : null)

function readCivitai(parsed: Raw): CivitaiResource[] {
  return rows(parsed.civitai_resources).map((r) => ({
    name: text(r.model_name) ?? '?',
    version: text(r.version_name),
    weight: text(r.weight),
    kind: airKind(r.air),
    url: httpUrl(r.civitai_url),
  }))
}

function readNodes(parsed: Raw): PromptNode[] {
  return rows(parsed.prompt_nodes).flatMap((r) => {
    const body = text(r.text)
    if (!body) return []
    const role = r.role === 'positive' || r.role === 'negative' ? r.role : null
    return [{ id: text(r.node_id) ?? '?', type: text(r.class_type) ?? '', role, text: body }]
  })
}

/** Where each group of the parser's model_assets lives. */
const GROUP_KEYS: [ModelGroupId, string][] = [
  ['checkpoint', 'checkpoint_candidates'],
  ['unet', 'unet_candidates'],
  ['vae', 'vae_candidates'],
  ['clip', 'clip_candidates'],
  ['diffusion', 'diffusion_model_candidates'],
  ['other', 'model_candidates'],
  ['detector', 'yolo_models'],
  ['guessLora', 'global_lora_candidates'],
  ['guessDetector', 'global_yolo_candidates'],
]

const nameOf = (v: unknown) => text(typeof v === 'string' ? v : obj(v).name)

function readOtherModels(parsed: Raw, mainModel: string | null): ModelGroup[] {
  const assets = obj(parsed.model_assets)
  const main = new Set([text(assets.primary_model_name), mainModel].filter((n): n is string => !!n).map((n) => n.toLowerCase()))
  const groups: ModelGroup[] = []
  for (const [group, key] of GROUP_KEYS) {
    const list = key === 'yolo_models' && !Array.isArray(assets.yolo_models) ? assets.yolo_candidates : assets[key]
    const names = [...new Set((Array.isArray(list) ? list : []).map(nameOf).filter((n): n is string => !!n))]
    const shown = group === 'checkpoint' || group === 'unet' ? names.filter((n) => !main.has(n.toLowerCase())) : names
    if (shown.length) groups.push({ group, names: shown })
  }
  return groups
}

/** A model or LoRA name the way the library matches it: file name only, no hash suffix, extension or weight. */
export function modelFilterValue(name: string): string {
  let value = name.trim().replace(/\\/g, '/').split('/').pop() ?? ''
  value = value.replace(/\s+\[[0-9a-fA-F]{4,}\]\s*$/, '')
  value = value.replace(/:-?\d+(\.\d+)?$/, '')
  value = value.replace(/\.(safetensors|ckpt|pt|pth|bin|onnx|gguf|sft)$/i, '')
  return value.replace(/\s+/g, ' ').trim()
}

function loraWeights(parsed: Raw): Map<string, string> {
  const weights = new Map<string, string>()
  for (const d of rows(obj(parsed.generation_params).lora_details)) {
    const name = text(d.name)
    const model = text(d.strength_model)
    if (!name || model === null) continue
    const clip = text(d.strength_clip)
    weights.set(modelFilterValue(name).toLowerCase(), clip !== null && clip !== model ? `${model} / ${clip}` : model)
  }
  return weights
}

export function readImageInfo(input: { metadata_json: string | null; model_hash: string | null; checkpoint: string | null }): ImageInfo {
  const parsed = parsedOf(input.metadata_json)
  const weights = loraWeights(parsed)
  return {
    img2img: readImg2Img(parsed),
    civitai: readCivitai(parsed),
    nodes: readNodes(parsed),
    modelHash: text(input.model_hash) ?? text(obj(parsed.generation_params).model_hash),
    otherModels: readOtherModels(parsed, input.checkpoint),
    loraWeight: (name) => weights.get(modelFilterValue(name).toLowerCase()) ?? null,
  }
}

export type NoParamsReason = 'gemini' | 'gptImage' | 'runtime' | 'none'

/**
 * Why an image shows no prompt: Gemini and GPT Image never embed one, a
 * ComfyUI graph may build it at run time, and anything else simply carries
 * none. Null when there is a prompt.
 */
export function noParamsReason(o: { generator: string | null; hasPrompt: boolean }): NoParamsReason | null {
  if (o.hasPrompt) return null
  if (o.generator === 'gemini') return 'gemini'
  if (o.generator === 'gpt-image') return 'gptImage'
  if (o.generator === 'comfyui') return 'runtime'
  return 'none'
}

/** An aesthetic score (about 1-10) as shown: two decimals. */
export function formatScore(score: number | null | undefined): string | null {
  return typeof score === 'number' && Number.isFinite(score) ? score.toFixed(2) : null
}
