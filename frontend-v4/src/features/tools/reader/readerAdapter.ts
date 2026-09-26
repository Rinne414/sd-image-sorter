import type { ImageDetail } from '../../../api/types'
import { modelFilterValue, readImageInfo, type ImageInfo } from '../../../lib/imageInfo'
import { readGeneration, type GenerationInfo } from '../../../lib/meta'
import { detectFormat, type SourceFormat } from '../../../lib/promptFormat'

// The Reader shows one image whichever way it came in: a dropped or pasted
// file (POST /api/parse-image) or a library image (GET /api/images/{id},
// read from the database, never uploaded again). Both are first turned into
// the library row's shape, so the generation card's readers (meta.ts,
// imageInfo.ts) give one answer for the same picture.

/** What POST /api/parse-image returns: the parser's result for the upload. */
export interface ParseResult {
  generator: string | null
  prompt: string | null
  negative_prompt: string | null
  checkpoint: string | null
  loras: string[] | null
  width: number
  height: number
  file_size: number
  /** The raw metadata; `_parsed` is what the parser made of it. */
  metadata: Record<string, unknown> | null
  sidecar_caption?: string | null
  metadata_error?: string | null
  /** The kept copy of the upload (24 h): what saving and tagging read from. */
  source_temp_path?: string
}

/** The library row's fields the Reader reads. */
export type ReaderRecord = Pick<
  ImageDetail,
  'generator' | 'prompt' | 'negative_prompt' | 'metadata_json' | 'checkpoint' | 'loras' | 'width' | 'height' | 'file_size' | 'sidecar_caption'
> & { model_hash: string | null }

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** An upload as the scan would have stored it (metadata_json keeps only `_parsed`). */
export function fromParse(p: ParseResult): ReaderRecord {
  const parsed = obj(obj(p.metadata)._parsed)
  return {
    generator: p.generator,
    prompt: p.prompt,
    negative_prompt: p.negative_prompt,
    metadata_json: JSON.stringify({ _parsed: parsed }),
    checkpoint: p.checkpoint,
    loras: JSON.stringify(p.loras ?? []),
    width: p.width,
    height: p.height,
    file_size: p.file_size,
    sidecar_caption: p.sidecar_caption ?? null,
    model_hash: text(obj(parsed.generation_params).model_hash),
  }
}

export function fromDetail(d: ImageDetail): ReaderRecord {
  return {
    generator: d.generator,
    prompt: d.prompt,
    negative_prompt: d.negative_prompt,
    metadata_json: d.metadata_json,
    checkpoint: d.checkpoint,
    loras: d.loras,
    width: d.width,
    height: d.height,
    file_size: d.file_size,
    sidecar_caption: d.sidecar_caption,
    model_hash: d.model_hash ?? null,
  }
}

export interface NamedHash {
  name: string
  hash: string
}

export interface Hashes {
  model: string | null
  loras: NamedHash[]
  /** Textual inversions (A1111 "TI hashes"). */
  embeddings: NamedHash[]
}

/** "a: 11, b: 22" (A1111 writes it quoted) as name / hash pairs. */
function hashList(v: unknown): NamedHash[] {
  const raw = text(v)?.replace(/^"|"$/g, '')
  if (!raw) return []
  return raw.split(',').flatMap((pair) => {
    const cut = pair.lastIndexOf(':')
    const name = pair.slice(0, cut).trim()
    const hash = pair.slice(cut + 1).trim()
    return cut > 0 && name && hash ? [{ name, hash }] : []
  })
}

/** The model, LoRA and embedding hashes an A1111-style image records. */
export function readHashes(params: Raw): Hashes {
  return {
    model: text(params.model_hash),
    loras: hashList(params.lora_hashes ?? params['Lora hashes']),
    embeddings: hashList(params.ti_hashes ?? params['TI hashes']),
  }
}

/** A LoRA's weight as the prompt writes it: <lora:name:0.7>. */
export function promptLoraWeight(prompt: string, name: string): string | null {
  const want = modelFilterValue(name).toLowerCase()
  for (const m of prompt.matchAll(/<(?:lora|lyco):([^:>]+):([^:>]+)(?::[^>]*)?>/gi)) {
    if (modelFilterValue(m[1] ?? '').toLowerCase() === want) return (m[2] ?? '').trim() || null
  }
  return null
}

export interface ReaderView {
  /** null when the parser could not tell. */
  generator: string | null
  prompt: string
  negative: string
  gen: GenerationInfo
  info: ImageInfo
  hashes: Hashes
  sourceFormat: SourceFormat
  width: number | null
  height: number | null
  fileSize: number | null
  sidecar: string | null
}

export function readRecord(r: ReaderRecord): ReaderView {
  const gen = readGeneration(r)
  const info = readImageInfo(r)
  const parsed = r.metadata_json ? obj(obj(safeJson(r.metadata_json))._parsed) : {}
  const generator = r.generator && r.generator !== 'unknown' ? r.generator : null
  const prompt = r.prompt ?? ''
  return {
    generator,
    prompt,
    negative: r.negative_prompt ?? '',
    gen,
    info,
    hashes: readHashes(obj(parsed.generation_params)),
    sourceFormat: detectFormat({ generator, text: `${prompt}\n${r.negative_prompt ?? ''}`, hasCharacters: gen.characters.length > 0, hasNodes: info.nodes.length > 0 }),
    width: r.width,
    height: r.height,
    fileSize: r.file_size,
    sidecar: text(r.sidecar_caption),
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
