import { annotationSelections, captionTransforms, templateOptions, type CaptionScope } from '../captionRules'
import { formFromSettings, readBatchDataset, splitList, type MaskExport, type ProjectSettings, type TrainerConfig } from '../datasetSettings'
import type { Entry } from '../entries'
import { MASKS, trainerProblems, withTrainer, type TrainerNote, type TrainerProblem } from '../trainerRules'

// A dataset batch's export: the four formats, which options each allows (the
// trainer rules, said on screen), the files' names, the steps estimate, the
// images left out before the backend would refuse the whole request, and the
// one request body the check and the export both send. Every function
// returns new data.

export type ExportFormat = 'kohya' | 'anima' | 'folder' | 'beside'
export const FORMATS: readonly ExportFormat[] = ['kohya', 'anima', 'folder', 'beside']

const CONFIG: Record<ExportFormat, TrainerConfig> = { kohya: 'kohya_toml', anima: 'anima_lora_toml', folder: 'none', beside: 'none' }

export function formatOf(s: ProjectSettings): ExportFormat {
  if (s.trainer.config === 'kohya_toml') return 'kohya'
  if (s.trainer.config === 'anima_lora_toml') return 'anima'
  return s.output.mode === 'beside_image' ? 'beside' : 'folder'
}

/** Contract version of each verified trainer (GET /api/dataset/trainers), by wire value. */
export type Contracts = Partial<Record<TrainerConfig, string>>

export type FormatNote = TrainerNote | 'cropOff'

const CROP_OFF = { enabled: false, alpha_threshold: 1, padding_percent: 0, background_mode: 'keep_background', solid_color: '#000000' } as const

/**
 * Settings for another format. What it cannot take is switched off and named:
 * a verified package (kohya, Anima) and "captions beside the originals" take
 * no pixel changes, and only a folder of copies can.
 */
export function withFormat(s: ProjectSettings, format: ExportFormat, contracts: Contracts): { settings: ProjectSettings; notes: FormatNote[] } {
  const config = CONFIG[format]
  const trained = withTrainer(s, config, contracts[config] ?? null)
  let next = trained.settings
  const notes: FormatNote[] = [...trained.notes]
  if (format !== 'folder' && next.subject_crop?.enabled) {
    next = { ...next, subject_crop: { ...next.subject_crop, enabled: false } }
    notes.push('cropOff')
  }
  if (format === 'beside') {
    if (next.bucket_resize?.enabled) {
      next = { ...next, bucket_resize: { ...next.bucket_resize, enabled: false } }
      notes.push('bucketOff')
    }
    if (next.watermark_removal?.enabled) {
      next = { ...next, watermark_removal: { ...next.watermark_removal, enabled: false } }
      notes.push('watermarkOff')
    }
    if (next.trainer.mask_export === 'anima_lora') {
      next = { ...next, trainer: { ...next.trainer, mask_export: 'none' } }
      notes.push('maskReset')
    }
  }
  const mode = format === 'beside' ? 'beside_image' : 'folder'
  if (next.output.mode !== mode) next = { ...next, output: { ...next.output, mode } }
  return { settings: next, notes: [...new Set(notes)] }
}

/** The export form's part of `from` on top of `current`: a caption rule saved meanwhile is kept. */
export function withExportPart(current: ProjectSettings, from: ProjectSettings): ProjectSettings {
  return {
    ...current,
    naming: from.naming,
    output: from.output,
    trainer: from.trainer,
    subject_crop: from.subject_crop,
    bucket_resize: from.bucket_resize,
    watermark_removal: from.watermark_removal,
    planning: from.planning,
  }
}

/** The options of the export form that a format or another option can rule out. */
export type OptionKey = 'crop' | 'bucket' | 'watermark' | 'masks' | 'nl' | 'move' | 'json'

/** Why an option cannot be used now. */
export type OptionBlock = 'package' | 'beside' | 'move' | 'folderImages' | 'copyNeeded' | 'json'

const isPackage = (s: ProjectSettings) => s.trainer.config !== 'none'
const moves = (s: ProjectSettings) => s.output.image_op === 'move'

/** A pixel change reads the stored mask or rewrites the copy: folder of copies only. */
function pixelBlock(s: ProjectSettings): OptionBlock | null {
  if (isPackage(s)) return 'package'
  if (s.output.mode === 'beside_image') return 'beside'
  if (moves(s)) return 'move'
  return null
}

function moveBlock(s: ProjectSettings): OptionBlock | null {
  if (isPackage(s)) return 'package'
  if (s.output.mode === 'beside_image') return 'beside'
  const copyOnly = s.subject_crop?.enabled || s.bucket_resize?.enabled || s.watermark_removal?.enabled || s.trainer.mask_export !== 'none'
  return copyOnly ? 'copyNeeded' : null
}

/** Null when the option can be used; otherwise why not (the form says it beside the option). */
export function optionBlock(key: OptionKey, s: ProjectSettings, folderImages: number): OptionBlock | null {
  switch (key) {
    case 'crop':
      return pixelBlock(s) ?? (folderImages > 0 ? 'folderImages' : null)
    case 'bucket':
    case 'watermark':
      return pixelBlock(s)
    case 'masks':
      return moves(s) && s.output.mode === 'folder' ? 'move' : null
    case 'nl':
    case 'json':
      return isPackage(s) ? 'package' : null
    case 'move':
      return moveBlock(s)
  }
}

/** The mask layouts this format can write. */
export function maskChoices(s: ProjectSettings): readonly MaskExport[] {
  const all = MASKS[s.trainer.config]
  return s.output.mode === 'beside_image' ? all.filter((m) => m !== 'anima_lora') : all
}

export type ExportProblem =
  | TrainerProblem
  | 'noImages'
  | 'noFolder'
  | 'cropNotHere'
  | 'cropFolderImages'
  | 'bucketFolderImages'
  | 'watermarkRegion'
  | 'maskMove'
  | 'nlPackage'
  | 'jsonPackage'

/** Everything that stops this export before it is checked, in the order the form shows it. */
export function exportProblems(s: ProjectSettings, send: number, folderImages: number, nl: boolean, json = false): ExportProblem[] {
  const out: ExportProblem[] = []
  if (send === 0) out.push('noImages')
  if (s.output.mode === 'folder' && !s.output.folder.trim()) out.push('noFolder')
  out.push(...trainerProblems(s))
  if (s.subject_crop?.enabled) {
    if (pixelBlock(s)) out.push('cropNotHere')
    if (folderImages > 0) out.push('cropFolderImages')
  }
  if (s.bucket_resize?.enabled && s.bucket_resize.subject_aware && folderImages > 0) out.push('bucketFolderImages')
  if (s.watermark_removal?.enabled && !(s.watermark_removal.regions ?? []).length) out.push('watermarkRegion')
  if (s.trainer.mask_export !== 'none' && moves(s) && s.output.mode === 'folder') out.push('maskMove')
  if (nl && isPackage(s)) out.push('nlPackage')
  if (json && isPackage(s)) out.push('jsonPackage')
  return out
}

// ---- file names ----

export type NamingPreset = ProjectSettings['naming']['preset']

/** V3.5's rule: keep the names, number them after the trigger (plain numbers without one), or the user's pattern. */
export function namingPattern(naming: ProjectSettings['naming'], trigger: string): string {
  const numbered = trigger.trim() ? '{trigger}_{index:03d}' : '{index:03d}'
  if (naming.preset === 'keep') return '{filename}'
  if (naming.preset === 'renumber') return numbered
  return naming.custom_pattern.trim() || numbered
}

/** An example output name for the form (the backend's render_stem decides the real one). */
export function sampleName(pattern: string, sample: { filename: string; index: number; trigger: string }): string {
  const dot = sample.filename.lastIndexOf('.')
  const stem = dot > 0 ? sample.filename.slice(0, dot) : sample.filename
  const ext = dot > 0 ? sample.filename.slice(dot) : '.png'
  const name = pattern
    .replace(/\{index:0?(\d+)d\}/g, (_m, width: string) => String(sample.index).padStart(Number(width), '0'))
    .replace(/\{index\}/g, String(sample.index))
    .replace(/\{filename\}/g, stem)
    .replace(/\{trigger\}/g, sample.trigger.trim())
    .replace(/\{ext\}/g, ext.slice(1))
  return `${name}${ext}`
}

/** kohya's convention: ceil(images x repeats / batch) x epochs. Bucketing and accumulation change the real number. */
export function stepsEstimate(images: number, repeats: number, batch: number, epochs: number): number {
  if (images <= 0) return 0
  return Math.ceil((images * Math.max(1, repeats)) / Math.max(1, batch)) * Math.max(1, epochs)
}

// ---- V4-only options, kept in the batch row (V3.5's strict settings have no place for them) ----

export interface V4Options {
  nl_sidecar: boolean
  dedupe_implications: boolean
  /** A .json of the image's details instead of the caption .txt (V3.5's "json" content mode); plain folder or beside only. */
  json_sidecar: boolean
}

function exportPart(settings: Record<string, unknown>): Record<string, unknown> {
  const dataset = settings.dataset && typeof settings.dataset === 'object' ? (settings.dataset as Record<string, unknown>) : {}
  return dataset.export && typeof dataset.export === 'object' ? (dataset.export as Record<string, unknown>) : {}
}

export function readV4Options(settings: Record<string, unknown>): V4Options {
  const part = exportPart(settings)
  return { nl_sidecar: part.nl_sidecar === true, dedupe_implications: part.dedupe_implications === true, json_sidecar: part.json_sidecar === true }
}

export function writeV4Options(settings: Record<string, unknown>, value: V4Options): Record<string, unknown> {
  const dataset = settings.dataset && typeof settings.dataset === 'object' ? (settings.dataset as Record<string, unknown>) : {}
  return { ...settings, dataset: { ...dataset, export: { ...exportPart(settings), ...value } } }
}

// ---- which images go ----

/**
 * Why an image is left out: its folder file changed since it was added or is
 * gone, its Library row is gone, or the backend refused it in the last check.
 * Sending any of them would make the backend refuse the whole export.
 */
export type LeftOutReason = 'changed' | 'missing' | 'gone' | 'refused'

export interface LeftOut {
  key: string
  name: string
  reason: LeftOutReason
}

function leftOutReason(entry: Entry, refused: ReadonlySet<string>): LeftOutReason | null {
  if (entry.imageId === null && entry.path === null) return 'gone'
  if (entry.imageId === null && entry.status === 'changed') return 'changed'
  if (entry.imageId === null && entry.status === 'missing') return 'missing'
  return refused.has(entry.key) ? 'refused' : null
}

export function splitEntries(entries: readonly Entry[], refused: ReadonlySet<string>): { send: Entry[]; leftOut: LeftOut[] } {
  const send: Entry[] = []
  const leftOut: LeftOut[] = []
  for (const entry of entries) {
    const reason = leftOutReason(entry, refused)
    if (reason) leftOut.push({ key: entry.key, name: entry.filename, reason })
    else send.push(entry)
  }
  return { send, leftOut }
}

export interface Choices {
  /** Leave out images with a problem the check can skip (not for verified packages). */
  skipBlocked: boolean
  /** Write an empty caption file for images without a caption. */
  allowEmpty: boolean
}

export interface BodyInput {
  settings: ProjectSettings
  batchSettings: Record<string, unknown>
  project: { id: number; revision: number }
  send: readonly Entry[]
  heads: CaptionScope['heads']
  options: V4Options
  choices: Choices
}

const BUCKET_OFF = { enabled: false, subject_aware: false, alpha_threshold: 128 } as const
const WATERMARK_OFF = { enabled: false, method: 'telea', radius: 3, padding_percent: 0, regions: [] } as const

/** The caption half of the body: the same rules every preview in the batch renders with. */
function captionPart(input: BodyInput) {
  const form = formFromSettings(input.settings, readBatchDataset(input.batchSettings))
  const options = templateOptions(form)
  return {
    content_mode: 'template' as const,
    trigger: options.trigger,
    prefix: form.prefix,
    template_options: options,
    caption_transforms: captionTransforms(form),
    blacklist: options.blacklist,
    common_tags: splitList(form.commonTags),
    normalize_tag_underscores: form.normalizeUnderscores,
    dataset_project_id: input.project.id,
    dataset_project_revision: input.project.revision,
    annotation_selections: annotationSelections(input.send, input.heads),
  }
}

/**
 * The .json half: V3.5's "json" content mode, one `<name>.json` per image with
 * its prompt, negative prompt, AI caption, tags (the batch blacklist applied),
 * checkpoint, size and generation settings, as the Library has them. It carries
 * no caption revisions, rules or common tags: the backend would put an edited
 * caption in place of the JSON (and refuses revisions for this mode), and the
 * comma rules would cut the JSON apart. The trigger stays for the file names.
 */
function jsonPart(input: BodyInput) {
  const form = formFromSettings(input.settings, readBatchDataset(input.batchSettings))
  return {
    content_mode: 'json' as const,
    trigger: form.trigger.trim(),
    prefix: '',
    blacklist: templateOptions(form).blacklist,
    common_tags: [] as string[],
    normalize_tag_underscores: form.normalizeUnderscores,
  }
}

/**
 * The one body POST /api/dataset/readiness/start checks and
 * /api/dataset/export/start then writes (with the check's proof added):
 * the same body twice, or the backend refuses the export.
 */
export function exportBody(input: BodyInput) {
  const s = input.settings
  const beside = s.output.mode === 'beside_image'
  const ids = input.send.flatMap((e) => (e.imageId !== null ? [e.imageId] : []))
  const paths = input.send.flatMap((e) => (e.imageId === null && e.path !== null ? [e.path] : []))
  const trigger = formFromSettings(s, readBatchDataset(input.batchSettings)).trigger.trim()
  // (a verified package takes .txt captions only: the choice is ignored there, and the form says so)
  const json = input.options.json_sidecar && !isPackage(s)
  const files = {
    image_ids: ids,
    image_paths: paths,
    output_folder: beside ? '' : s.output.folder.trim(),
    output_mode: s.output.mode,
    naming_pattern: namingPattern(s.naming, trigger),
    image_op: beside || s.trainer.config !== 'none' ? 'copy' : s.output.image_op,
    overwrite_policy: s.output.overwrite_policy,
    mask_export: s.trainer.mask_export,
    subject_crop: s.subject_crop ?? CROP_OFF,
    bucket_resize: s.bucket_resize ?? BUCKET_OFF,
    watermark_removal: s.watermark_removal ?? WATERMARK_OFF,
    trainer_config: s.trainer.config,
    trainer_repeats: s.trainer.repeats,
    trainer_batch: s.trainer.batch,
    trainer_resolution: s.trainer.resolution,
    trainer_keep_tokens: s.trainer.keep_tokens,
    // Chosen options only: an export without them sends what V3.5 sends.
    ...(input.options.nl_sidecar && !json ? { nl_sidecar: true } : {}),
    ...(input.options.dedupe_implications ? { dedupe_implications: true } : {}),
    ...(input.choices.skipBlocked ? { skip_blocked_items: true } : {}),
    ...(input.choices.allowEmpty ? { allow_empty_captions: true } : {}),
  }
  // (two shapes: the caption body V3.5 sends, or the .json one without any caption source)
  return json ? { ...files, ...jsonPart(input) } : { ...files, ...captionPart(input) }
}

export type ExportBody = ReturnType<typeof exportBody>
