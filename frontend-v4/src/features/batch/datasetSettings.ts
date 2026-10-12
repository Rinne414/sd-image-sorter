import type { components } from '../../api/schema'

// A dataset batch's training settings. Most live in its project as V3.5's
// strict V1 settings (so V3.5 reads the same values); what V1 has no place
// for (the training purpose and the categories to drop) lives in the batch
// row under `settings.dataset`. Every function returns new data.

export type ProjectSettings = components['schemas']['DatasetProjectSettingsV1-Output']
export type TargetModel = ProjectSettings['target_model']
export type TrainerConfig = ProjectSettings['trainer']['config']
export type MaskExport = ProjectSettings['trainer']['mask_export']

export const TARGET_MODELS: readonly TargetModel[] = ['', 'sdxl', 'flux', 'krea2', 'anima']

/** What the LoRA is for; each suggests which tag categories to leave out of captions. */
export const PURPOSES = ['character', 'style', 'outfit', 'pose', 'concept', 'general'] as const
export type Purpose = (typeof PURPOSES)[number]

/** Tag categories a caption can drop (the classifier's 14 minus "unknown", which is never dropped wholesale). */
export const CATEGORIES = [
  'quality',
  'meta',
  'rating',
  'character',
  'body',
  'outfit',
  'expression',
  'pose',
  'action',
  'angle',
  'background',
  'style',
  'artist',
] as const
export type Category = (typeof CATEGORIES)[number]

/** V3.5's LoRA-type defaults: what the LoRA learns stays out of the captions, plus training noise. */
export const PURPOSE_CATEGORIES: Record<Purpose, readonly Category[]> = {
  character: ['character', 'body', 'quality', 'meta', 'rating'],
  style: ['style', 'artist', 'meta', 'quality', 'rating'],
  outfit: ['outfit', 'quality', 'meta', 'rating'],
  pose: ['pose', 'action', 'angle', 'quality', 'meta', 'rating'],
  concept: ['quality', 'meta', 'rating'],
  general: ['quality', 'meta', 'rating'],
}

/** The batch row's own dataset settings (`settings.dataset`). */
export interface BatchDatasetSettings {
  training_purpose: Purpose | null
  remove_categories: Category[]
}

const isPurpose = (v: unknown): v is Purpose => typeof v === 'string' && (PURPOSES as readonly string[]).includes(v)
const isCategory = (v: unknown): v is Category => typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v)

export function readBatchDataset(settings: Record<string, unknown>): BatchDatasetSettings {
  const raw = settings.dataset
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const cats = Array.isArray(obj.remove_categories) ? obj.remove_categories.filter(isCategory) : []
  return { training_purpose: isPurpose(obj.training_purpose) ? obj.training_purpose : null, remove_categories: [...new Set(cats)] }
}

export function writeBatchDataset(settings: Record<string, unknown>, value: BatchDatasetSettings): Record<string, unknown> {
  const old = settings.dataset && typeof settings.dataset === 'object' ? (settings.dataset as Record<string, unknown>) : {}
  return { ...settings, dataset: { ...old, training_purpose: value.training_purpose, remove_categories: [...value.remove_categories] } }
}

/**
 * The one list parser for tags typed by hand: commas or line breaks, each
 * trimmed, empty ones dropped, repeats (any case, _ or space) kept once.
 */
export function splitList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[\n\r,]+/)) {
    const tag = part.trim()
    const key = tag.toLowerCase().replace(/_/g, ' ')
    if (!tag || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

export const joinList = (list: readonly string[]): string => list.join(', ')

/** Replace rules as V3.5 writes them: one `from -> to` (or `=>`) per line. */
export function parseReplaceRules(text: string): Record<string, string> {
  const rules: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const arrow = line.includes('->') ? '->' : line.includes('=>') ? '=>' : null
    if (!arrow) continue
    const [from = '', ...rest] = line.split(arrow)
    const key = from.trim()
    if (key) rules[key] = rest.join(arrow).trim()
  }
  return rules
}

export const formatReplaceRules = (rules: Record<string, string>): string =>
  Object.entries(rules)
    .map(([from, to]) => `${from} -> ${to}`)
    .join('\n')

/** What the settings strip edits. Lists are kept as typed; they are parsed on the way out. */
export interface DatasetForm {
  trigger: string
  targetModel: TargetModel
  purpose: Purpose | null
  removeCategories: Category[]
  commonTags: string
  blacklist: string
  maxTags: number
  template: string
  replaceRules: string
  prefix: string
  normalizeUnderscores: boolean
}

export function formFromSettings(project: ProjectSettings, batch: BatchDatasetSettings): DatasetForm {
  const render = project.caption_render
  return {
    trigger: render.trigger,
    targetModel: project.target_model,
    purpose: batch.training_purpose,
    removeCategories: [...batch.remove_categories],
    commonTags: joinList(render.common_tags),
    blacklist: joinList(render.blacklist),
    maxTags: render.template.max_tags,
    template: render.template.template_override,
    replaceRules: formatReplaceRules(render.template.replace_rules),
    prefix: render.prefix,
    normalizeUnderscores: render.normalize_tag_underscores,
  }
}

/** The project settings with the form's values; everything the form does not edit stays as it was. */
export function settingsFromForm(form: DatasetForm, base: ProjectSettings): ProjectSettings {
  const render = base.caption_render
  return {
    ...base,
    target_model: form.targetModel,
    caption_render: {
      ...render,
      trigger: form.trigger.trim(),
      common_tags: splitList(form.commonTags),
      blacklist: splitList(form.blacklist),
      normalize_tag_underscores: form.normalizeUnderscores,
      prefix: form.prefix,
      template: {
        template_override: form.template.trim() || render.template.template_override,
        replace_rules: parseReplaceRules(form.replaceRules),
        max_tags: Math.max(0, Math.min(1000, Math.floor(form.maxTags) || 0)),
      },
    },
  }
}

export const batchDatasetFromForm = (form: DatasetForm): BatchDatasetSettings => ({
  training_purpose: form.purpose,
  remove_categories: [...form.removeCategories],
})

export type TriggerProblem = 'comma' | 'breaks' | 'long' | 'blank'

/** Why the backend would refuse this trigger (one token, 100 characters at most), or null. */
export function triggerProblem(text: string): TriggerProblem | null {
  const trigger = text.trim()
  if (trigger.includes(',')) return 'comma'
  if (/[\t\n\r\v\f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(trigger)) return 'breaks'
  if (trigger.length > 100) return 'long'
  if (text.length > 0 && trigger.length > 0 && !trigger.replace(/_/g, ' ').trim()) return 'blank'
  return null
}

const tagKey = (tag: string) => tag.trim().toLowerCase().replace(/_/g, ' ')

/**
 * A new trigger replaces the old one: the old one joins the blacklist so no
 * caption keeps it, and the new one leaves the blacklist if it was there.
 */
export function withTriggerChange(form: DatasetForm, oldTrigger: string): DatasetForm {
  const old = tagKey(oldTrigger)
  const now = tagKey(form.trigger)
  const list = splitList(form.blacklist)
  const kept = now ? list.filter((tag) => tagKey(tag) !== now) : list
  const next = old && old !== now && !kept.some((tag) => tagKey(tag) === old) ? [...kept, oldTrigger.trim()] : kept
  return next.length === list.length && next.every((tag, i) => tag === list[i]) ? form : { ...form, blacklist: joinList(next) }
}

/** The purpose's suggested categories replace the current ones. */
export function withPurpose(form: DatasetForm, purpose: Purpose | null): DatasetForm {
  return { ...form, purpose, removeCategories: purpose ? [...PURPOSE_CATEGORIES[purpose]] : [] }
}

export function toggleCategory(form: DatasetForm, category: Category): DatasetForm {
  const has = form.removeCategories.includes(category)
  return { ...form, removeCategories: has ? form.removeCategories.filter((c) => c !== category) : [...form.removeCategories, category] }
}

/** The categories differ from what the purpose suggests. */
export function categoriesChanged(form: DatasetForm): boolean {
  const suggested = new Set(form.purpose ? PURPOSE_CATEGORIES[form.purpose] : [])
  return form.removeCategories.length !== suggested.size || form.removeCategories.some((c) => !suggested.has(c))
}
