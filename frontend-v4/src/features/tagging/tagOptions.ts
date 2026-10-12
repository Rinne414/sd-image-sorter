import type { Describer } from '../batch/datasetTag'

// The tag panel's choices, as the Library panel and a dataset batch's tag
// step both keep them, and the request bodies they turn into. Pure except for
// the remembered choices in localStorage (V4 only; V3.5 keeps its own).

/** The model value that means "my own ONNX file" (V3.5's select used the same word). */
export const CUSTOM_MODEL = 'custom'

/** The families a custom ONNX file can come from; V3.5 offers the same three. */
export const CUSTOM_PROFILES = ['wd14', 'camie-tagger-v2', 'pixai-tagger-v0.9'] as const
export type CustomProfile = (typeof CUSTOM_PROFILES)[number]

/** The built-in tagger each family behaves like (its default thresholds). */
export const CUSTOM_PROFILE_MODEL: Record<CustomProfile, string> = {
  wd14: 'wd-swinv2-tagger-v3',
  'camie-tagger-v2': 'camie-tagger-v2',
  'pixai-tagger-v0.9': 'pixai-tagger-v0.9',
}

export interface CustomModel {
  profile: CustomProfile
  modelPath: string
  /** Optional: the backend looks beside the model when empty. */
  tagsPath: string
}

/** What a run does with a caption or description an image already has. */
export type MergeStrategy = 'replace' | 'append'

export interface TagOptions {
  /** A tagger's name, or CUSTOM_MODEL. */
  model: string
  /** null: the model's own default. */
  threshold: number | null
  characterThreshold: number | null
  copyrightThreshold: number | null
  useGpu: boolean
  /** Tags dropped before they are written; they never reach the library. */
  blacklist: string[]
  /** 0 = keep every tag above the threshold. */
  maxTags: number
  /** Drop quality, score and meta tags (masterpiece, score_9 ...) from a Smart Tag run. */
  autoStripNoise: boolean
  mergeStrategy: MergeStrategy
  custom: CustomModel
}

/** What one run does: never remembered, the panel's entry point decides. */
export interface RunChoice {
  /** The booru tagger runs; off = a description-only run that leaves the tags alone. */
  tagger: boolean
  describer: Describer
  toriiLength: 'brief' | 'detailed'
  grounding: boolean
}

/** A plain tag run: the tagger only, no description. */
export const TAG_ONLY: RunChoice = { tagger: true, describer: 'off', toriiLength: 'detailed', grounding: true }

export const isCustom = (o: Pick<TagOptions, 'model'>) => o.model === CUSTOM_MODEL

/** The custom file's name, for the jobs drawer. */
export function customLabel(path: string): string {
  const name = path.trim().split(/[\\/]/).pop()
  return name || 'ONNX'
}

/** POST /api/tag/start: the plain tag run (the only one that takes a custom ONNX file or a drop list). */
export function tagStartBody(ids: number[] | null, o: TagOptions) {
  const custom = isCustom(o)
  return {
    // No ids: the backend tags every image that has no tags yet.
    ...(ids ? { image_ids: ids } : {}),
    model_name: custom ? o.custom.profile : o.model,
    ...(custom
      ? { model_path: o.custom.modelPath.trim(), tags_path: o.custom.tagsPath.trim() || null, custom_profile: o.custom.profile }
      : {}),
    threshold: o.threshold,
    character_threshold: o.characterThreshold,
    use_gpu: o.useGpu,
    pre_tag_blacklist: o.blacklist,
    max_tags_per_image: o.maxTags,
    retag_all: false,
    allow_unsafe_acceleration: false,
  }
}

/** The thresholds a Smart Tag run sends (unset ones are the tagger's own). */
export function smartThresholds(o: Pick<TagOptions, 'threshold' | 'characterThreshold' | 'copyrightThreshold'>) {
  return {
    ...(o.threshold !== null ? { general_threshold: o.threshold } : {}),
    ...(o.characterThreshold !== null ? { character_threshold: o.characterThreshold } : {}),
    ...(o.copyrightThreshold !== null ? { copyright_threshold: o.copyrightThreshold } : {}),
  }
}

/**
 * POST /api/smart-tag/start for Library picks: tag and describe, or describe
 * only (the tagger off: the tags stay as they are). Every pick runs, as the
 * panel says. Smart Tag has no drop list and takes no custom file.
 */
export function librarySmartTagBody(ids: number[], o: TagOptions, run: RunChoice) {
  return {
    image_ids: ids,
    image_paths: [],
    training_purpose: 'general',
    trigger_word: '',
    merge_strategy: o.mergeStrategy,
    auto_strip_noise: o.autoStripNoise,
    skip_existing: false,
    enable_wd14: run.tagger,
    enable_vlm: run.describer !== 'off',
    tagger_model: run.tagger ? o.model : '',
    use_gpu: o.useGpu,
    ...(run.tagger ? smartThresholds(o) : {}),
    max_tags_per_image: run.tagger ? o.maxTags : 0,
    natural_language_mode: run.describer === 'off' ? 'vlm' : run.describer,
    toriigate_caption_length: run.toriiLength,
    vlm_grounding: run.grounding,
    toriigate_grounding: run.grounding,
  }
}

// ---- remembered choices ----

const OPTIONS_KEY = 'sd-v4-tag-options'

interface StoredThresholds {
  general: number | null
  character: number | null
  copyright?: number | null
}

type Stored = Partial<Pick<TagOptions, 'model' | 'useGpu' | 'blacklist' | 'maxTags' | 'autoStripNoise' | 'mergeStrategy'>> & {
  thresholds?: Record<string, StoredThresholds>
  custom?: Partial<Record<keyof CustomModel, unknown>>
  advancedOpen?: boolean
}

function readStored(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Stored) : {}
  } catch {
    return {}
  }
}

function writeStored(s: Stored): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(s))
  } catch {
    // storage blocked: the choices just won't be remembered
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

function readCustom(c: Stored['custom']): CustomModel {
  const profile = CUSTOM_PROFILES.find((p) => p === c?.profile) ?? 'wd14'
  return { profile, modelPath: str(c?.modelPath), tagsPath: str(c?.tagsPath) }
}

/** Last choices, so the next run starts where this one left off. Thresholds are per tagger. */
export function loadTagOptions(fallbackModel: string): TagOptions {
  const s = readStored()
  const model = typeof s.model === 'string' && s.model ? s.model : fallbackModel
  const t = rememberedFrom(s, model)
  return {
    model,
    threshold: t.general,
    characterThreshold: t.character,
    copyrightThreshold: t.copyright,
    useGpu: typeof s.useGpu === 'boolean' ? s.useGpu : true,
    blacklist: Array.isArray(s.blacklist) ? s.blacklist.filter((x) => typeof x === 'string') : [],
    maxTags: typeof s.maxTags === 'number' && s.maxTags >= 0 ? s.maxTags : 0,
    autoStripNoise: typeof s.autoStripNoise === 'boolean' ? s.autoStripNoise : true,
    mergeStrategy: s.mergeStrategy === 'append' ? 'append' : 'replace',
    custom: readCustom(s.custom),
  }
}

export function saveTagOptions(o: TagOptions): void {
  const prev = readStored()
  const thresholds = { ...(prev.thresholds ?? {}), [o.model]: { general: o.threshold, character: o.characterThreshold, copyright: o.copyrightThreshold } }
  writeStored({
    model: o.model,
    useGpu: o.useGpu,
    blacklist: o.blacklist,
    maxTags: o.maxTags,
    autoStripNoise: o.autoStripNoise,
    mergeStrategy: o.mergeStrategy,
    custom: { ...o.custom },
    thresholds,
    ...(prev.advancedOpen !== undefined ? { advancedOpen: prev.advancedOpen } : {}),
  })
}

/** Whether 高级设置 was left open (the Library panel and the tag step share it). */
export function loadAdvancedOpen(): boolean {
  return readStored().advancedOpen === true
}

export function saveAdvancedOpen(open: boolean): void {
  writeStored({ ...readStored(), advancedOpen: open })
}

/** Something is remembered (the tag panel then offers to forget it). */
export function hasStoredTagOptions(): boolean {
  try {
    return localStorage.getItem(OPTIONS_KEY) !== null
  } catch {
    return false
  }
}

/** Forget every remembered choice: the next run starts from the defaults. Only V4 keeps these. */
export function clearTagOptions(): void {
  try {
    localStorage.removeItem(OPTIONS_KEY)
  } catch {
    // storage blocked: nothing was remembered either
  }
}

const unit = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function rememberedFrom(s: Stored, model: string): { general: number | null; character: number | null; copyright: number | null } {
  const t = s.thresholds?.[model]
  return { general: unit(t?.general), character: unit(t?.character), copyright: unit(t?.copyright) }
}

/** The thresholds remembered for one tagger (null = its default). */
export function rememberedThresholds(model: string) {
  return rememberedFrom(readStored(), model)
}

// ---- a custom file the backend refused ----

export interface CustomPathProblem {
  field: 'model' | 'tags'
  kind: 'ext' | 'missing' | 'notFile' | 'bad'
}

const MISSING = /File does not exist|Symlink target does not exist/
const NOT_FILE = /Path is not a file|Symlink target is not a file/

/** What was wrong with the custom paths, read from the backend's refusal (null: something else). */
export function customPathProblem(detail: string): CustomPathProblem | null {
  const field = /^Custom ONNX tagger model/.test(detail) ? 'model' : /^Custom tags\/metadata/.test(detail) ? 'tags' : null
  if (!field) return null
  if (/ must be /.test(detail)) return { field, kind: 'ext' }
  if (MISSING.test(detail)) return { field, kind: 'missing' }
  if (NOT_FILE.test(detail)) return { field, kind: 'notFile' }
  return { field, kind: 'bad' }
}
