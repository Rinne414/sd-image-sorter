// A Pixiv batch's naming and export settings. They live in the batch's
// settings (`settings.export`, saved through the batch queue); a new batch
// starts from the last ones used (localStorage), except what belongs to one
// post only: the caption, overwriting, and keeping generation data, which
// always starts off (removed). Every function returns new data.

import { stampTemplate } from './names'

export type MetadataOption = 'strip' | 'keep' | 'minimal'
export type OutputFormat = 'original' | 'png' | 'jpg' | 'webp'
export type WatermarkPosition = 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right' | 'center'
export type MissingPolicy = 'block' | 'skip' | 'original'

export interface WatermarkSettings {
  enabled: boolean
  text: string
  position: WatermarkPosition
  /** 1-100 */
  opacity: number
  /** 1-20, of the shorter side */
  size_percent: number
  /** 0-10 */
  margin_percent: number
  /** '#RRGGBB': the user's watermark colour (data, not a design colour). */
  color: string
}

export interface ExportSettings {
  name_template: string
  start_number: number
  output_folder: string
  metadata_option: MetadataOption
  output_format: OutputFormat
  overwrite: boolean
  caption_text: string
  watermark: WatermarkSettings
}

export const DEFAULT_TEMPLATE = '{batch}_{n:02}'
export const METADATA_OPTIONS: readonly MetadataOption[] = ['strip', 'minimal', 'keep']
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['original', 'png', 'jpg', 'webp']
export const WATERMARK_POSITIONS: readonly WatermarkPosition[] = ['top_left', 'top_right', 'center', 'bottom_left', 'bottom_right']

export const DEFAULT_WATERMARK: WatermarkSettings = {
  enabled: false,
  text: '',
  position: 'bottom_right',
  opacity: 80,
  size_percent: 8,
  margin_percent: 2,
  color: '#FFFFFF',
}

export const DEFAULT_EXPORT: ExportSettings = {
  name_template: DEFAULT_TEMPLATE,
  start_number: 1,
  output_folder: '',
  metadata_option: 'strip',
  output_format: 'original',
  overwrite: false,
  caption_text: '',
  watermark: DEFAULT_WATERMARK,
}

const LAST_USED_KEY = 'sd-v4-pixiv-export'
const TEMPLATE_MAX = 200

type Raw = Record<string, unknown>

const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback

function intIn(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback
}

function parseWatermark(raw: unknown, fallback: WatermarkSettings): WatermarkSettings {
  if (!isRecord(raw)) return fallback
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    text: typeof raw.text === 'string' ? raw.text.slice(0, TEMPLATE_MAX) : fallback.text,
    position: oneOf(raw.position, WATERMARK_POSITIONS, fallback.position),
    opacity: intIn(raw.opacity, 1, 100, fallback.opacity),
    size_percent: intIn(raw.size_percent, 1, 20, fallback.size_percent),
    margin_percent: intIn(raw.margin_percent, 0, 10, fallback.margin_percent),
    color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color.toUpperCase() : fallback.color,
  }
}

/** Settings from stored JSON: every field checked, anything missing or broken taken from `fallback`. */
export function parseExportSettings(raw: unknown, fallback: ExportSettings = DEFAULT_EXPORT): ExportSettings {
  if (!isRecord(raw)) return fallback
  const template = typeof raw.name_template === 'string' && raw.name_template.trim() ? raw.name_template.slice(0, TEMPLATE_MAX) : fallback.name_template
  return {
    name_template: template,
    start_number: intIn(raw.start_number, 0, Number.MAX_SAFE_INTEGER, fallback.start_number),
    output_folder: typeof raw.output_folder === 'string' ? raw.output_folder : fallback.output_folder,
    metadata_option: oneOf(raw.metadata_option, METADATA_OPTIONS, fallback.metadata_option),
    output_format: oneOf(raw.output_format, OUTPUT_FORMATS, fallback.output_format),
    overwrite: typeof raw.overwrite === 'boolean' ? raw.overwrite : fallback.overwrite,
    caption_text: typeof raw.caption_text === 'string' ? raw.caption_text : fallback.caption_text,
    watermark: parseWatermark(raw.watermark, fallback.watermark),
  }
}

/** What a new batch starts with: the last settings used, minus what belongs to one post only. */
export function newBatchDefaults(lastUsed: ExportSettings): ExportSettings {
  return { ...lastUsed, metadata_option: 'strip', overwrite: false, caption_text: '' }
}

/** This batch's settings: its own when saved, else the defaults for a new batch. */
export function batchExportSettings(settings: Raw, lastUsed: ExportSettings): ExportSettings {
  return parseExportSettings(settings.export, newBatchDefaults(lastUsed))
}

/** The batch's settings object with these export settings in it. */
export function withExportSettings(settings: Raw, next: ExportSettings): Raw {
  return { ...settings, export: next }
}

export function readLastUsed(): ExportSettings {
  try {
    const raw = localStorage.getItem(LAST_USED_KEY)
    return raw ? parseExportSettings(JSON.parse(raw)) : DEFAULT_EXPORT
  } catch {
    return DEFAULT_EXPORT
  }
}

export function rememberLastUsed(settings: ExportSettings): void {
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify(settings))
  } catch {
    // storage blocked: new batches start from the defaults
  }
}

/** The body of POST /api/batches/{id}/export/names: what decides the file names ({date}/{time} as at `when`). */
export function namesBody(settings: ExportSettings, policy: MissingPolicy, when: Date) {
  return {
    name_template: stampTemplate(settings.name_template, when),
    start_number: settings.start_number,
    output_format: settings.output_format,
    missing_censored: policy,
  }
}

/** The body of POST /api/batches/{id}/export; `when` is the moment the export starts. */
export function exportBody(settings: ExportSettings, policy: MissingPolicy, when: Date) {
  return {
    ...namesBody(settings, policy, when),
    output_folder: settings.output_folder,
    metadata_option: settings.metadata_option,
    overwrite: settings.overwrite,
    caption_text: settings.caption_text,
    watermark: settings.watermark,
  }
}

/** Why the watermark cannot be used as it is, or null. */
export function watermarkProblem(watermark: WatermarkSettings): 'text' | null {
  return watermark.enabled && !watermark.text.trim() ? 'text' : null
}
