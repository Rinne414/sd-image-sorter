// Text exports of the picks' generation data (POST /api/images/export-data
// rows), ported from V3.5's combined export. One exception, on purpose: the
// caption lines split the prompt and tags on commas before dropping repeats,
// so a tag that is also in the prompt is written once.

export const EXPORT_FORMATS = [
  'prompt',
  'prompt_numbered',
  'negative',
  'prompt_negative',
  'a1111',
  'tags',
  'caption_tags',
  'caption_merged',
  'jsonl',
  'csv',
] as const

export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export interface ExportImage {
  id: number
  filename: string
  generator: string | null
  prompt: string
  negative_prompt: string
  ai_caption: string
  tags: string[]
  checkpoint: string | null
  width: number | null
  height: number | null
  aesthetic_score: number | null
  generation_params: Record<string, unknown>
}

export function fileExtension(format: ExportFormat): 'txt' | 'jsonl' | 'csv' {
  return format === 'jsonl' ? 'jsonl' : format === 'csv' ? 'csv' : 'txt'
}

const clean = (v: unknown) => String(v ?? '').trim()
const squash = (v: string) => v.replace(/\s+/g, ' ').trim()

/** Distinct parts (case-insensitive), in first-seen order. */
function uniqueParts(parts: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of parts) {
    const part = squash(raw).replace(/^,+|,+$/g, '').trim()
    const key = part.toLowerCase()
    if (!part || seen.has(key)) continue
    seen.add(key)
    out.push(part)
  }
  return out
}

const commaParts = (text: string) => text.split(',')

function params(img: ExportImage): Record<string, unknown> {
  const p: Record<string, unknown> = { ...img.generation_params }
  if (!p.model && img.checkpoint) p.model = img.checkpoint
  if (!p.size && img.width && img.height) p.size = `${img.width}x${img.height}`
  return p
}

const A1111_ORDER: [string, string][] = [
  ['steps', 'Steps'],
  ['sampler', 'Sampler'],
  ['schedule_type', 'Schedule type'],
  ['cfg_scale', 'CFG scale'],
  ['seed', 'Seed'],
  ['size', 'Size'],
  ['model', 'Model'],
  ['model_hash', 'Model hash'],
  ['clip_skip', 'Clip skip'],
  ['denoising_strength', 'Denoising strength'],
  ['loras', 'LoRAs'],
]

const present = (v: unknown) => v !== null && v !== undefined && v !== ''
const titleCase = (key: string) =>
  key
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')

function a1111Block(img: ExportImage): string {
  const lines: string[] = []
  const prompt = clean(img.prompt)
  const negative = clean(img.negative_prompt)
  if (prompt) lines.push(prompt)
  if (negative) lines.push(`Negative prompt: ${negative}`)
  const p = params(img)
  const known = new Set(A1111_ORDER.map(([k]) => k))
  const parts = A1111_ORDER.filter(([k]) => present(p[k])).map(([k, label]) => `${label}: ${String(p[k])}`)
  for (const key of Object.keys(p).sort()) {
    if (!known.has(key) && present(p[key])) parts.push(`${titleCase(key)}: ${String(p[key])}`)
  }
  if (parts.length) lines.push(parts.join(', '))
  return lines.join('\n').trim()
}

function record(img: ExportImage) {
  return {
    id: img.id,
    filename: img.filename || '',
    generator: img.generator || null,
    prompt: img.prompt || '',
    negative_prompt: img.negative_prompt || '',
    ai_caption: img.ai_caption || '',
    tags: img.tags ?? [],
    checkpoint: img.checkpoint || null,
    width: img.width || null,
    height: img.height || null,
    aesthetic_score: img.aesthetic_score ?? null,
    generation_params: params(img),
  }
}

const csvField = (v: unknown) => {
  const text = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const CSV_COLUMNS = ['id', 'filename', 'generator', 'prompt', 'negative_prompt', 'ai_caption', 'tags', 'checkpoint', 'width', 'height'] as const

export function buildExportText(images: ExportImage[], format: ExportFormat): string {
  const nonEmpty = (list: string[], sep: string) => list.filter(Boolean).join(sep)
  switch (format) {
    case 'prompt':
      return nonEmpty(images.map((i) => clean(i.prompt)), '\n\n')
    case 'prompt_numbered':
      return nonEmpty(
        images.map((i, n) => (clean(i.prompt) ? `${n + 1}. ${clean(i.filename) || `#${i.id}`}\n${clean(i.prompt)}` : '')),
        '\n\n',
      )
    case 'negative':
      return nonEmpty(images.map((i) => clean(i.negative_prompt)), '\n\n')
    case 'prompt_negative':
      return nonEmpty(
        images.map((i) => nonEmpty([clean(i.prompt), clean(i.negative_prompt) ? `Negative prompt: ${clean(i.negative_prompt)}` : ''], '\n')),
        '\n\n',
      )
    case 'a1111':
      return nonEmpty(images.map(a1111Block), '\n\n')
    case 'tags':
      return [...new Set(images.flatMap((i) => i.tags ?? []))].sort().join(', ')
    case 'caption_tags':
      return nonEmpty(images.map((i) => uniqueParts([i.ai_caption, ...(i.tags ?? []).flatMap(commaParts)]).join(', ')), '\n')
    case 'caption_merged':
      return nonEmpty(
        images.map((i) => uniqueParts([i.ai_caption, ...commaParts(i.prompt ?? ''), ...(i.tags ?? []).flatMap(commaParts)]).join(', ')),
        '\n',
      )
    case 'jsonl':
      return images.map((i) => JSON.stringify(record(i))).join('\n')
    case 'csv': {
      const rows = images.map((i) => {
        const r = record(i)
        const cells: unknown[] = [r.id, r.filename, r.generator, r.prompt, r.negative_prompt, r.ai_caption, r.tags.join(', '), r.checkpoint, r.width, r.height]
        return cells.map(csvField).join(',')
      })
      return [CSV_COLUMNS.join(','), ...rows].join('\n')
    }
  }
}
