import { parseReplaceRules, splitList, type DatasetForm, type TargetModel } from './datasetSettings'
import type { Entry } from './entries'

// How a dataset batch's settings turn into the rules every caption gets (D27).
// The trigger and common tags are put in front, the blacklist and the chosen
// categories are taken out, by `caption_transforms`: the backend applies them
// to hand-edited captions and to rendered ones alike, so changing the trigger
// never leaves the old one behind in an edited caption. The preview sends the
// very same body the export will.

/** V3.5's default template (migration 033). */
export const DEFAULT_TEMPLATE = '{trigger}, {tags:filtered}, {append}'

export interface ModelProfile {
  /** Template preset of GET /api/tags/export-presets (its template and defaults). */
  preset: string
  /** Smart Tag caption profile for this model's descriptions, if it needs its own. */
  captionProfile: string | null
}

/** The base model decides the template preset: tags for SDXL and Anima, natural language first for FLUX and Krea 2. */
export const MODEL_PROFILES: Record<TargetModel, ModelProfile> = {
  '': { preset: 'custom', captionProfile: null },
  sdxl: { preset: 'illustrious_pony', captionProfile: null },
  flux: { preset: 'flux', captionProfile: null },
  krea2: { preset: 'flux', captionProfile: 'krea2_long_nl' },
  anima: { preset: 'anima', captionProfile: null },
}

export interface TemplatePreset {
  id: string
  template: string
}

/** The template a base model starts from. */
export function defaultTemplate(model: TargetModel, presets: readonly TemplatePreset[]): string {
  const id = MODEL_PROFILES[model].preset
  if (id === 'custom') return DEFAULT_TEMPLATE
  return presets.find((p) => p.id === id)?.template ?? DEFAULT_TEMPLATE
}

/** A new base model brings its template, unless the template is one the user wrote. */
export function withTargetModel(form: DatasetForm, model: TargetModel, presets: readonly TemplatePreset[]): DatasetForm {
  const now = form.template.trim()
  const own = now !== '' && now !== DEFAULT_TEMPLATE && now !== defaultTemplate(form.targetModel, presets).trim()
  return { ...form, targetModel: model, template: own ? form.template : defaultTemplate(model, presets) }
}

/** The template is not the base model's own. */
export const templateIsOwn = (form: DatasetForm, presets: readonly TemplatePreset[]): boolean =>
  form.template.trim() !== defaultTemplate(form.targetModel, presets).trim()

export interface CaptionTransforms {
  prepend: string[]
  remove: string[]
  remove_categories: string[]
}

export function captionTransforms(form: DatasetForm): CaptionTransforms {
  const trigger = form.trigger.trim()
  return {
    prepend: [...(trigger ? [trigger] : []), ...splitList(form.commonTags)],
    remove: splitList(form.blacklist),
    remove_categories: [...form.removeCategories],
  }
}

/** Template options for images whose caption was never edited (the template path). */
export function templateOptions(form: DatasetForm) {
  return {
    preset_id: MODEL_PROFILES[form.targetModel].preset,
    template_override: form.template.trim() || DEFAULT_TEMPLATE,
    trigger: form.trigger.trim(),
    blacklist: splitList(form.blacklist),
    replace_rules: parseReplaceRules(form.replaceRules),
    max_tags: Math.max(0, Math.floor(form.maxTags) || 0),
    append: splitList(form.commonTags),
    underscore_to_space_override: form.normalizeUnderscores,
    preserve_underscore_prefixes_override: ['score_'],
  }
}

/** Entries the preview can render: Library images that still exist, folder images still on disk. */
export function previewable(entries: readonly Entry[]): { ids: number[]; paths: string[] } {
  const ids: number[] = []
  const paths: string[] = []
  for (const entry of entries) {
    if (entry.imageId !== null) ids.push(entry.imageId)
    else if (entry.path !== null && entry.status !== 'missing') paths.push(entry.path)
  }
  return { ids, paths }
}

/** The project's caption revisions a preview names (by entry key), at the project revision they belong to. */
export interface CaptionScope {
  projectId: number
  projectRevision: number
  heads: ReadonlyMap<string, { revisionId?: number }>
}

export type AnnotationSelection = { kind: 'revision_ref'; revision_id: number } | { kind: 'dynamic_source' }

/**
 * Each entry's caption as the export takes it: its active revision, or the
 * template when it was never edited. Keys are what the backend matches:
 * a Library image's id, a folder image's path.
 */
export function annotationSelections(entries: readonly Entry[], heads: CaptionScope['heads']): Record<string, AnnotationSelection> {
  const out: Record<string, AnnotationSelection> = {}
  for (const entry of entries) {
    const key = entry.imageId !== null ? String(entry.imageId) : entry.path
    if (key === null || (entry.imageId === null && entry.status === 'missing')) continue
    const revision = heads.get(entry.key)?.revisionId
    out[key] = revision ? { kind: 'revision_ref', revision_id: revision } : { kind: 'dynamic_source' }
  }
  return out
}

/**
 * The body of POST /api/dataset/export-preview: these entries under the
 * form's rules. With a scope, edited images show their revision (the same
 * selections the export sends); a folder image whose file changed since it
 * was added has no caption the backend can name, so it is left out then.
 */
export function previewBody(form: DatasetForm, entries: readonly Entry[], limit: number, scope?: CaptionScope | null) {
  const named = scope ? entries.filter((e) => !(e.imageId === null && e.status === 'changed')) : entries
  const { ids, paths } = previewable(named)
  const options = templateOptions(form)
  const selections = scope ? annotationSelections(named, scope.heads) : {}
  return {
    image_ids: ids,
    image_paths: paths,
    content_mode: 'template',
    prefix: form.prefix,
    trigger: options.trigger,
    blacklist: options.blacklist,
    common_tags: options.append,
    normalize_tag_underscores: form.normalizeUnderscores,
    template_options: options,
    caption_transforms: captionTransforms(form),
    limit: Math.max(1, Math.min(500, limit)),
    ...(scope && Object.keys(selections).length > 0
      ? { dataset_project_id: scope.projectId, dataset_project_revision: scope.projectRevision, annotation_selections: selections }
      : {}),
  }
}

/** Which tokens of a final caption the batch rules put there (they lead it). */
export function ruleTokens(caption: string, form: DatasetForm): { token: string; fromRule: boolean }[] {
  const lead = new Set(captionTransforms(form).prepend.map((t) => t.toLowerCase().replace(/_/g, ' ')))
  return caption
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((token) => ({ token, fromRule: lead.has(token.toLowerCase().replace(/_/g, ' ')) }))
}
