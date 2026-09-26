import { MODEL_PROFILES } from '../../batch/captionRules'
import type { TargetModel } from '../../batch/datasetSettings'
import type { TagOptions } from '../../tagging/tagJob'

// Reverse prompt: three ways to work out a prompt from a picture, and what
// each one sends. The tagger answers at once (POST /api/tag/single); the two
// vision-model ways are a Smart Tag run on the one file (start, poll, read).
// Neither ever writes to the library. Pure; runReverse.ts does the calls.

/** grounded: tag first, then hand the tags to the vision model with the image (the default). */
export type ReverseMode = 'grounded' | 'tagger' | 'vlm'

export const MODES: readonly ReverseMode[] = ['grounded', 'tagger', 'vlm']

export const needsTagger = (m: ReverseMode) => m !== 'vlm'
export const needsVlm = (m: ReverseMode) => m !== 'tagger'

const thresholds = (o: TagOptions) => ({
  ...(o.threshold !== null ? { general_threshold: o.threshold } : {}),
  ...(o.characterThreshold !== null ? { character_threshold: o.characterThreshold } : {}),
})

/** POST /api/tag/single: the tagger the user chose in the tag panel, not the backend's default. */
export function tagSingleBody(path: string, o: TagOptions) {
  return { image_path: path, tagger_model: o.model, ...thresholds(o), use_gpu: o.useGpu }
}

/** POST /api/smart-tag/start for one file: its result is read back, nothing is stored. */
export function smartTagBody(mode: Exclude<ReverseMode, 'tagger'>, path: string, target: TargetModel, o: TagOptions) {
  const profile = MODEL_PROFILES[target].captionProfile
  return {
    image_paths: [path],
    enable_wd14: mode === 'grounded',
    enable_vlm: true,
    vlm_grounding: mode === 'grounded',
    natural_language_mode: 'vlm',
    merge_strategy: 'replace',
    skip_existing: false,
    training_purpose: 'general',
    trigger_word: '',
    auto_strip_noise: true,
    tagger_model: o.model,
    ...thresholds(o),
    use_gpu: o.useGpu,
    ...(profile === 'krea2_long_nl' ? { caption_profile: 'krea2_long_nl' as const } : {}),
    // the backend's own defaults, written out (one tagger, no ToriiGate)
    consensus_min: 1,
    toriigate_caption_length: 'detailed',
    toriigate_max_new_tokens: 0,
    toriigate_grounding: false,
  }
}

/** A target written for in natural language: TIPO only grows tag lists, so it is off there. */
export const tipoOffFor = (target: TargetModel): boolean => target === 'krea2'

export function tagsToPrompt(tags: readonly string[]): string {
  const names = tags.map((t) => t.trim()).filter(Boolean).map((t) => (/^score_\d/.test(t) ? t : t.replace(/_/g, ' ')))
  return [...new Set(names)].join(', ')
}

export function promptToTags(text: string): string[] {
  return text.split(',').map((p) => p.trim()).filter(Boolean)
}

/** The draft's parts that read as tags (short, no sentence punctuation): what TIPO can honestly be given. */
export function draftTags(draft: string): string[] {
  return promptToTags(draft).filter((p) => !/[.!?;:]/.test(p) && p.split(/\s+/).length <= 6)
}

const fold = (tag: string) => tag.trim().toLowerCase().replace(/_/g, ' ')

/** The draft with these tags added once each (case and underscores ignored). */
export function appendTags(draft: string, tags: readonly string[]): { text: string; added: number } {
  const parts = promptToTags(draft)
  const seen = new Set(parts.map(fold))
  let added = 0
  for (const tag of tags) {
    if (seen.has(fold(tag))) continue
    seen.add(fold(tag))
    parts.push(tag.trim().replace(/_/g, ' '))
    added += 1
  }
  return { text: parts.join(', '), added }
}

type Raw = Record<string, unknown>
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * The caption of a finished run, or why there is none. A run can succeed on
 * paper and still carry no text (the vision model failed for this image);
 * that is an error with the reason the run kept, never an empty prompt. The
 * job's `message` ("Done. 1 ok…") is not a reason.
 */
export function captionOf(page: Raw, finished: Raw): { prompt: string } | { error: string | null } {
  const caption = str(rows(page.results)[0]?.caption)
  if (caption) return { prompt: caption }
  return { error: str(rows(finished.errors)[0]?.error) || null }
}
