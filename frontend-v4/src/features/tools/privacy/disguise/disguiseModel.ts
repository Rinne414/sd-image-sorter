import type { MessageKey } from '../../../../i18n'
import { parentFolder } from '../../../../lib/paths'

// The cover-picture disguise's settings and the pure rules around them: what
// is sent to the program, what a reason code or an error means in words, and
// small formatters. No React, no network (disguiseApi.ts and disguiseRun.ts
// do those), so all of it is unit-tested.

export type CoverKind = 'default' | 'mosaic' | 'text' | 'blur' | 'upload'
export const COVER_KINDS: readonly CoverKind[] = ['default', 'mosaic', 'text', 'blur', 'upload']

export type PackFormat = 'disguise' | 'gif'

export interface DisguiseSettings {
  coverKind: CoverKind
  /** Empty sends the program's own default words ("Open to view"). */
  coverText: string
  coverBg: string
  coverFg: string
  /** All pictures become one file that plays them in turn. */
  pack: boolean
  packFormat: PackFormat
  frameSeconds: number
  /** 0 keeps the original size. */
  maxSide: number
  scrub: boolean
  /** Empty: the program's own disguise folder. */
  outputFolder: string
}

export const DEFAULT_MAX_SIDE = 1600
export const DEFAULT_FRAME_SECONDS = 1
export const CARD_BACKGROUND = '#26272b'
export const CARD_FOREGROUND = '#f2f2f2'

export const DEFAULT_DISGUISE: DisguiseSettings = {
  coverKind: 'default',
  coverText: '',
  coverBg: CARD_BACKGROUND,
  coverFg: CARD_FOREGROUND,
  pack: false,
  packFormat: 'disguise',
  frameSeconds: DEFAULT_FRAME_SECONDS,
  maxSide: DEFAULT_MAX_SIDE,
  scrub: true,
  outputFolder: '',
}

const HEX = /^#[0-9a-f]{6}$/i

/** Saved settings, each field checked on its own: a damaged or old value falls back to the default. */
export function readDisguise(raw: string | null): DisguiseSettings {
  try {
    const s = JSON.parse(raw ?? 'null') as Partial<Record<keyof DisguiseSettings, unknown>> | null
    if (!s || typeof s !== 'object') return { ...DEFAULT_DISGUISE }
    const d = DEFAULT_DISGUISE
    return {
      coverKind: COVER_KINDS.includes(s.coverKind as CoverKind) ? (s.coverKind as CoverKind) : d.coverKind,
      coverText: typeof s.coverText === 'string' ? s.coverText : d.coverText,
      coverBg: typeof s.coverBg === 'string' && HEX.test(s.coverBg) ? s.coverBg : d.coverBg,
      coverFg: typeof s.coverFg === 'string' && HEX.test(s.coverFg) ? s.coverFg : d.coverFg,
      pack: s.pack === true,
      packFormat: s.packFormat === 'gif' ? 'gif' : 'disguise',
      frameSeconds: typeof s.frameSeconds === 'number' && s.frameSeconds > 0 ? s.frameSeconds : d.frameSeconds,
      maxSide: typeof s.maxSide === 'number' && Number.isInteger(s.maxSide) && s.maxSide >= 0 ? s.maxSide : d.maxSide,
      scrub: typeof s.scrub === 'boolean' ? s.scrub : d.scrub,
      outputFolder: typeof s.outputFolder === 'string' ? s.outputFolder : d.outputFolder,
    }
  } catch {
    return { ...DEFAULT_DISGUISE }
  }
}

/** Milliseconds per picture for the program; at least 1. */
export function frameMs(seconds: number): number {
  return Math.max(1, Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_FRAME_SECONDS) * 1000))
}

/** A plain looping GIF has no cover, so no cover needs choosing for it. */
export const needsCover = (s: DisguiseSettings): boolean => !(s.pack && s.packFormat === 'gif')

/** The detector the Censor page is set to, as the program's mosaic cover takes it. */
export interface DetectorChoice {
  modelType: 'nudenet' | 'legacy' | 'both'
  modelPath: string
  confidence: number
  targets: string[]
}

/** The Censor page's detector for a mosaic cover: SAM3 (words, not parts) falls back to NudeNet. */
export function detectorChoice(detector: string | null, yolo: string, customPath: string, confidence: number, targets: readonly string[]): DetectorChoice {
  const modelType = detector === 'legacy' || detector === 'both' ? detector : 'nudenet'
  const modelPath = modelType === 'nudenet' ? '' : customPath.trim() || yolo
  return { modelType, modelPath, confidence, targets: [...targets] }
}

export type FormEntry = readonly [name: string, value: string]

export interface FormContext {
  /** The text a text card shows when the field is empty (in the language of the page). */
  defaultText: string
  /** The name for the made file; null lets the program name it after the picture. */
  outputName: string | null
  detector: DetectorChoice
}

/** Every field of one make request except the pictures and the cover file. */
export function makeFields(s: DisguiseSettings, ctx: FormContext): FormEntry[] {
  const fields: FormEntry[] = [
    ['cover_kind', s.coverKind],
    ['cover_text', s.coverText.trim() || ctx.defaultText],
    ['cover_background', s.coverBg],
    ['cover_foreground', s.coverFg],
    ['frame_ms', String(frameMs(s.frameSeconds))],
    ['max_side', String(s.maxSide)],
    ['scrub', String(s.scrub)],
    ['output_folder', s.outputFolder.trim()],
  ]
  if (ctx.outputName) fields.push(['output_name', ctx.outputName])
  if (s.pack && s.packFormat === 'gif') fields.push(['output_format', 'gif'])
  if (s.coverKind === 'mosaic') {
    fields.push(['detect_model_type', ctx.detector.modelType], ['detect_model_path', ctx.detector.modelPath], ['detect_confidence', String(ctx.detector.confidence)], ['detect_targets', JSON.stringify(ctx.detector.targets)])
  }
  return fields
}

/** What the program answers to a make request. */
export type MakeAnswer =
  | { status: 'needs_cover'; reason: string }
  | {
      status: 'ok'
      token: string
      file_url: string
      output_path: string
      file_name: string
      cover_preview: string
      width: number
      height: number
      real_frames: number
      bytes: number
    }

export function isMakeAnswer(value: unknown): value is MakeAnswer {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.status === 'needs_cover') return typeof v.reason === 'string'
  return (
    v.status === 'ok' &&
    typeof v.token === 'string' &&
    typeof v.file_url === 'string' &&
    typeof v.output_path === 'string' &&
    typeof v.file_name === 'string' &&
    typeof v.cover_preview === 'string' &&
    typeof v.width === 'number' &&
    typeof v.height === 'number' &&
    typeof v.real_frames === 'number' &&
    typeof v.bytes === 'number'
  )
}

const REASONS: Record<string, MessageKey> = {
  nothing_detected: 'disguise.reason.nothing_detected',
  detector_unavailable: 'disguise.reason.detector_unavailable',
  not_in_library: 'disguise.reason.not_in_library',
  no_default_cover: 'disguise.reason.no_default_cover',
  no_upload: 'disguise.reason.no_upload',
}

/** The key that words a "needs a cover" reason, and the {reason} param when the code is not known. */
export function reasonWords(reason: string): { key: MessageKey; params?: { reason: string } } {
  const key = REASONS[reason]
  return key ? { key } : { key: 'disguise.reason.unknown', params: { reason: reason || '?' } }
}

/** The key that words an error from the program, with the detail to fill in when the key has one. */
export function problemWords(status: number | undefined, detail: string): { key: MessageKey; params?: { detail: string } } {
  const d = detail.toLowerCase()
  if (d.includes('not a disguise')) return { key: 'disguise.err.notDisguise' }
  if (d.includes('damaged')) return { key: 'disguise.err.damaged' }
  if (status === 413) return { key: 'disguise.err.tooLarge' }
  if (status === 404 && d.includes('image')) return { key: 'disguise.err.libraryGone' }
  if (d.includes('not a readable image') || d.includes('is not readable')) return { key: 'disguise.err.unreadable' }
  if (status === 400 && d.includes('folder')) return { key: 'disguise.err.folder', params: { detail } }
  return { key: 'disguise.err.generic', params: { detail } }
}

/** The folder a saved file is in (the path as the program gave it). */
export const folderOf = (path: string): string => parentFolder(path) ?? path

/** "420 KB" / "1.2 MB". */
export function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(value / 1024))} KB`
}
