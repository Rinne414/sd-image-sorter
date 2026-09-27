import type { Params } from '../../../i18n'
import { shortModelName } from '../../../lib/meta'
import type { ToolKey } from '../toolText'
import type { ReaderView } from './readerAdapter'

// The Reader's metadata editor: the nine fields V3.5 edits, what they send to
// POST /api/image-metadata/save-edited, and the file names a saved copy gets.
// Pure; MetadataEditor.tsx holds the form.

export interface MetaFields {
  prompt: string
  negative: string
  seed: string
  model: string
  sampler: string
  steps: string
  cfg: string
  size: string
  loras: string
}

export const FIELD_ORDER: readonly (keyof MetaFields)[] = ['prompt', 'negative', 'seed', 'model', 'sampler', 'steps', 'cfg', 'size', 'loras']

export function fieldsOf(v: Pick<ReaderView, 'prompt' | 'negative' | 'gen'>): MetaFields {
  return {
    prompt: v.prompt,
    negative: v.negative,
    seed: v.gen.seed ?? '',
    model: v.gen.model ? shortModelName(v.gen.model) : '',
    sampler: v.gen.sampler ?? '',
    steps: v.gen.steps ?? '',
    cfg: v.gen.cfg ?? '',
    size: (v.gen.size ?? '').replace('×', 'x'),
    loras: v.gen.loras.join(', '),
  }
}

/** The field that cannot be sent as it is, or null. */
export function fieldProblem(f: MetaFields): 'steps' | 'cfg' | null {
  const steps = f.steps.trim()
  if (steps && !(/^\d+$/.test(steps) && Number(steps) > 0)) return 'steps'
  const cfg = f.cfg.trim()
  if (cfg && !Number.isFinite(Number(cfg))) return 'cfg'
  return null
}

/** The body's `metadata`: filled fields only, steps and CFG as numbers. */
export function payloadOf(f: MetaFields): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  const put = (key: string, value: string) => {
    const v = value.trim()
    if (v) out[key] = v
  }
  put('prompt', f.prompt)
  put('negative_prompt', f.negative)
  put('seed', f.seed)
  put('model', f.model)
  put('sampler', f.sampler)
  if (f.steps.trim()) out.steps = Number.parseInt(f.steps.trim(), 10)
  if (f.cfg.trim()) out.cfg_scale = Number.parseFloat(f.cfg.trim())
  put('size', f.size)
  put('loras', f.loras)
  return out
}

export function changedFields(before: MetaFields, after: MetaFields): (keyof MetaFields)[] {
  return FIELD_ORDER.filter((k) => before[k].trim() !== after[k].trim())
}

export type SaveFormat = 'png' | 'webp' | 'jpg'

export const SAVE_FORMATS: readonly SaveFormat[] = ['png', 'webp', 'jpg']

export function formatOf(name: string): SaveFormat | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'jpeg' || ext === 'jpg') return 'jpg'
  return ext === 'png' || ext === 'webp' ? ext : null
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** <name>.edited.<format>, beside the source by default. */
export function editedName(source: string, format: SaveFormat): string {
  const name = baseName(source)
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
  return `${stem || 'image'}.edited.${format}`
}

export function withFormat(name: string, format: SaveFormat): string {
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
  return `${stem}.${format}`
}

export function splitPath(path: string): { folder: string; name: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? { folder: '', name: path } : { folder: path.slice(0, cut), name: path.slice(cut + 1) }
}

/** Two paths name one file: Windows paths ignore case and slash direction. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.trim().replace(/\\/g, '/')
    return /^[A-Za-z]:\//.test(s) || s.startsWith('//') ? s.toLowerCase() : s
  }
  return !!a.trim() && norm(a) === norm(b)
}

/** One save warning as the backend names it (POST /api/image-metadata/save-edited `warning_codes`). */
export interface WarningCode {
  code: string
  params?: Record<string, unknown>
}

const WARNING_KEYS: Record<string, ToolKey> = {
  jpeg_limited: 'reader.warn.jpegLimited',
  webp_limited: 'reader.warn.webpLimited',
  jpeg_alpha_flattened: 'reader.warn.alphaFlattened',
  record_preserved: 'reader.warn.recordPreserved',
  chunks_not_carried: 'reader.warn.chunksNotCarried',
  animation_flattened: 'reader.warn.animationFlattened',
  settings_dropped: 'reader.warn.settingsDropped',
  nai_fields_unsaved: 'reader.warn.naiFieldsUnsaved',
  library_refresh_failed: 'reader.warn.refreshFailed',
}

const listOf = (v: unknown) => (Array.isArray(v) ? v.map(String).join(', ') : '')

/** A warning in the user's words: a known code with its values, anything else as the backend wrote it. */
export function warningMessage(w: WarningCode, english: string | undefined): { key: ToolKey; params: Params } | { text: string } {
  const key = WARNING_KEYS[w.code]
  if (!key) return { text: String(w.params?.text ?? english ?? w.code) }
  const p = w.params ?? {}
  return { key, params: { keys: listOf(p.keys), format: String(p.format ?? ''), frames: typeof p.frames === 'number' ? p.frames : String(p.frames ?? '') } }
}
