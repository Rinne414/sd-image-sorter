import type { MaskExport, ProjectSettings, TrainerConfig } from './datasetSettings'

// The trainer rules of V3.5's strict project settings, kept in step with
// `DatasetProjectSettingsV1.validate_trainer_contract` (backend
// services/dataset_project_models.py): the screen switches off what a
// verified trainer cannot take, and says why, instead of letting a save fail.

/** The mask layouts each trainer takes. */
export const MASKS: Record<TrainerConfig, readonly MaskExport[]> = {
  none: ['none', 'onetrainer', 'kohya'],
  kohya_toml: ['none', 'kohya'],
  anima_lora_toml: ['none', 'anima_lora'],
}

export type TrainerProblem =
  | 'mask'
  | 'fixedNumbers'
  | 'bucketTrainer'
  | 'bucketResolution'
  | 'bucketOutput'
  | 'watermarkTrainer'
  | 'watermarkOutput'
  | 'contractNone'
  | 'contractMissing'
  | 'trainerOutput'

const copiesToFolder = (s: ProjectSettings) => s.output.mode === 'folder' && s.output.image_op === 'copy'

/** Resolution 1024 and keep_tokens 0 are fixed for Anima, and for "no trainer" without bucket resizing. */
export const numbersFixed = (s: ProjectSettings): boolean =>
  s.trainer.config === 'anima_lora_toml' || (s.trainer.config === 'none' && !s.bucket_resize?.enabled)

/** Everything the backend would refuse in these settings, in its order. */
export function trainerProblems(s: ProjectSettings): TrainerProblem[] {
  const t = s.trainer
  const out: TrainerProblem[] = []
  if (!MASKS[t.config].includes(t.mask_export)) out.push('mask')
  if (numbersFixed(s) && (t.resolution !== 1024 || t.keep_tokens !== 0)) out.push('fixedNumbers')
  if (s.bucket_resize?.enabled) {
    if (t.config !== 'none') out.push('bucketTrainer')
    if (t.resolution % 64 !== 0) out.push('bucketResolution')
    if (!copiesToFolder(s)) out.push('bucketOutput')
  }
  if (s.watermark_removal?.enabled) {
    if (t.config !== 'none') out.push('watermarkTrainer')
    if (!copiesToFolder(s)) out.push('watermarkOutput')
  }
  if (t.config === 'none') {
    if (t.contract_version !== null) out.push('contractNone')
  } else {
    if (t.contract_version === null) out.push('contractMissing')
    if (!copiesToFolder(s)) out.push('trainerOutput')
  }
  return out
}

/** What changing the trainer switched off or reset, to be said on screen. */
export type TrainerNote = 'bucketOff' | 'watermarkOff' | 'maskReset' | 'outputCopy' | 'resolution1024' | 'keepTokens0'

/**
 * Settings for another trainer. A verified trainer (Kohya, Anima) takes no
 * bucket resizing or watermark removal and writes copies into a folder; its
 * `contractVersion` comes from GET /api/dataset/trainers.
 */
export function withTrainer(
  settings: ProjectSettings,
  config: TrainerConfig,
  contractVersion: string | null,
): { settings: ProjectSettings; notes: TrainerNote[] } {
  const notes: TrainerNote[] = []
  let next: ProjectSettings = {
    ...settings,
    trainer: { ...settings.trainer, config, contract_version: config === 'none' ? null : contractVersion },
  }
  if (config !== 'none') {
    if (next.bucket_resize?.enabled) {
      next = { ...next, bucket_resize: { ...next.bucket_resize, enabled: false } }
      notes.push('bucketOff')
    }
    if (next.watermark_removal?.enabled) {
      next = { ...next, watermark_removal: { ...next.watermark_removal, enabled: false } }
      notes.push('watermarkOff')
    }
    if (!copiesToFolder(next)) {
      next = { ...next, output: { ...next.output, mode: 'folder', image_op: 'copy' } }
      notes.push('outputCopy')
    }
  }
  if (!MASKS[config].includes(next.trainer.mask_export)) {
    next = { ...next, trainer: { ...next.trainer, mask_export: 'none' } }
    notes.push('maskReset')
  }
  if (numbersFixed(next)) {
    if (next.trainer.resolution !== 1024) notes.push('resolution1024')
    if (next.trainer.keep_tokens !== 0) notes.push('keepTokens0')
    next = { ...next, trainer: { ...next.trainer, resolution: 1024, keep_tokens: 0 } }
  }
  return { settings: next, notes }
}
