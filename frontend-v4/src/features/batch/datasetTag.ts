import { smartThresholds, type MergeStrategy } from '../tagging/tagOptions'
import { MODEL_PROFILES } from './captionRules'
import { folderKey, libraryKey } from './datasetItems'
import type { Purpose, TargetModel } from './datasetSettings'
import type { Entry } from './entries'

// Pure rules of a dataset batch's tag step (Smart Tag: a tagger, and an
// optional describer). Library images get their tags and description in the
// Library (D28); folder images have no Library row, so their results become
// caption revisions marked as AI output. The trigger word never goes to the
// Library: it is always sent empty. Every function returns new data.

/** Who writes the natural-language description, if anyone (off by default, D29). */
export type Describer = 'off' | 'vlm' | 'florence2' | 'toriigate'

export interface TagStepOptions {
  model: string
  /** null: the tagger's own default. */
  threshold: number | null
  characterThreshold: number | null
  /** 0: every tag above the threshold. */
  maxTags: number
  useGpu: boolean
  /** A second tagger that votes with the first, or null. */
  secondModel: string | null
  /** With two taggers: keep a tag either one found, or only tags both found. */
  agreement: 'any' | 'both'
  describer: Describer
  toriiLength: 'brief' | 'detailed'
  /** Send the found tags to the describer as context. */
  grounding: boolean
  /** Also run on images that were tagged before (their Library tags are replaced). */
  retagExisting: boolean
  /** The booru tagger runs; off = a description-only run that leaves the tags alone. */
  tagger: boolean
  copyrightThreshold: number | null
  /** Drop quality, score and meta tags (masterpiece, score_9 ...). */
  autoStripNoise: boolean
  /** What happens to a caption or description an image already has. */
  mergeStrategy: MergeStrategy
}

export type SmartTagPurpose = 'general' | 'style' | 'character' | 'concept'

/**
 * The batch's purpose in Smart Tag's words. An outfit or pose LoRA teaches a
 * concept: its description must not guess which detail is the target.
 */
export function smartTagPurpose(purpose: Purpose | null): SmartTagPurpose {
  switch (purpose) {
    case 'character':
      return 'character'
    case 'style':
      return 'style'
    case 'concept':
    case 'outfit':
    case 'pose':
      return 'concept'
    default:
      return 'general'
  }
}

export type Author = 'user' | 'ai' | 'system' | 'import'

/** A caption revision a subject already has (by entry key). */
export interface HeadInfo {
  generation: number
  author: Author | null
  /** The active revision, its subject and content (set when read from the server). */
  revisionId?: number
  subjectId?: number
  content?: CaptionContent
}

export interface TagScope {
  /** Library images the tagger has not run on yet. */
  untagged: number
  /** Library images it has. */
  tagged: number
  /** Folder images without a caption revision. */
  folderNew: number
  /** Folder images that have one. */
  folderDone: number
  /** Images whose file (or Library row) is gone: never sent. */
  missing: number
  /** Entry keys whose caption the user edited: their caption stays as the user left it. */
  userEdited: string[]
  /** What this run sends. */
  ids: number[]
  paths: string[]
}

/** Which images a run takes, and the counts said before it starts. */
export function tagScope(
  entries: readonly Entry[],
  taggedIds: ReadonlySet<number>,
  heads: ReadonlyMap<string, HeadInfo>,
  retagExisting: boolean,
): TagScope {
  const scope: TagScope = { untagged: 0, tagged: 0, folderNew: 0, folderDone: 0, missing: 0, userEdited: [], ids: [], paths: [] }
  for (const entry of entries) {
    if (heads.get(entry.key)?.author === 'user') scope.userEdited.push(entry.key)
    if (entry.ref.kind === 'library') {
      if (entry.imageId === null) {
        scope.missing += 1
        continue
      }
      const done = taggedIds.has(entry.imageId)
      if (done) scope.tagged += 1
      else scope.untagged += 1
      if (retagExisting || !done) scope.ids.push(entry.imageId)
      continue
    }
    if (entry.status === 'missing' || entry.path === null) {
      scope.missing += 1
      continue
    }
    const done = heads.has(entry.key)
    if (done) scope.folderDone += 1
    else scope.folderNew += 1
    if (retagExisting || !done) scope.paths.push(entry.path)
  }
  return scope
}

/** How many times the configured VLM service is called (it may charge per call). */
export function vlmCalls(scope: TagScope, describer: Describer): number {
  return describer === 'vlm' ? scope.ids.length + scope.paths.length : 0
}

/** The body of POST /api/smart-tag/start for this run. */
export function smartTagBody(o: TagStepOptions, scope: TagScope, purpose: Purpose | null, targetModel: TargetModel) {
  const describe = o.describer !== 'off'
  const profile = o.describer === 'vlm' ? MODEL_PROFILES[targetModel].captionProfile : null
  // With the tagger off nothing is tagged: no thresholds, no second tagger.
  const thresholds = o.tagger ? smartThresholds(o) : {}
  return {
    image_ids: scope.ids,
    image_paths: scope.paths,
    training_purpose: smartTagPurpose(purpose),
    trigger_word: '',
    merge_strategy: o.mergeStrategy,
    auto_strip_noise: o.autoStripNoise,
    skip_existing: !o.retagExisting,
    enable_wd14: o.tagger,
    enable_vlm: describe,
    tagger_model: o.tagger ? o.model : '',
    use_gpu: o.useGpu,
    ...thresholds,
    max_tags_per_image: o.tagger ? o.maxTags : 0,
    natural_language_mode: o.describer === 'off' ? 'vlm' : o.describer,
    ...(profile ? { caption_profile: profile } : {}),
    taggers: o.tagger && o.secondModel ? [{ model: o.model, ...thresholds }, { model: o.secondModel }] : [],
    consensus_min: o.agreement === 'both' ? 2 : 1,
    toriigate_caption_length: o.toriiLength,
    vlm_grounding: o.grounding,
    toriigate_grounding: o.grounding,
  }
}

/** One folder image's Smart Tag result (GET /api/smart-tag/results). */
export interface SmartTagResult {
  path: string
  caption: string
  booru_text: string
  nl_text: string
}

export interface CaptionContent {
  content_version: 1
  booru_caption: string
  nl_caption: string
  caption_type: 'booru' | 'nl' | 'both'
}

export function resultContent(row: SmartTagResult): CaptionContent {
  const booru = row.booru_text.trim()
  const nl = row.nl_text.trim()
  return { content_version: 1, booru_caption: booru, nl_caption: nl, caption_type: booru && nl ? 'both' : nl ? 'nl' : 'booru' }
}

/** A result with tags is the tagger's; one with only a description is the describer's. */
export const resultSource = (row: SmartTagResult): 'wd14' | 'vlm' => (row.booru_text.trim() ? 'wd14' : 'vlm')

/** One part of a caption after a run (V3.5's rule): an empty result keeps what was there; append joins. */
function mergeChannel(existing: string, incoming: string, separator: string, merge: MergeStrategy): string {
  if (!incoming) return existing
  if (merge === 'replace' || !existing || existing === incoming) return incoming
  return `${existing}${separator}${incoming}`
}

/** The caption a result leaves on an image that had `had` (tags and words are merged separately). */
export function mergedContent(had: CaptionContent | undefined, row: SmartTagResult, merge: MergeStrategy): CaptionContent {
  const fresh = resultContent(row)
  const booru = mergeChannel(had?.booru_caption.trim() ?? '', fresh.booru_caption, ', ', merge)
  const nl = mergeChannel(had?.nl_caption.trim() ?? '', fresh.nl_caption, ' ', merge)
  return { content_version: 1, booru_caption: booru, nl_caption: nl, caption_type: booru && nl ? 'both' : nl ? 'nl' : 'booru' }
}

const sameContent = (a: CaptionContent | undefined, b: CaptionContent) =>
  !!a && a.booru_caption.trim() === b.booru_caption && a.nl_caption.trim() === b.nl_caption

export interface RevisionToWrite {
  path: string
  content: CaptionContent
  source: 'wd14' | 'vlm'
  generation: number
}

/**
 * The folder images' results as caption revisions, merged into the caption
 * each image had (`merge`). An image whose caption the user edited keeps it
 * (listed in `kept`); an empty or unchanged result writes nothing.
 */
export function revisionsFromResults(
  rows: readonly SmartTagResult[],
  heads: ReadonlyMap<string, HeadInfo>,
  merge: MergeStrategy = 'replace',
): { write: RevisionToWrite[]; kept: string[]; empty: number } {
  const write: RevisionToWrite[] = []
  const kept: string[] = []
  let empty = 0
  for (const row of rows) {
    const head = heads.get(folderKey(row.path))
    if (head?.author === 'user') {
      kept.push(row.path)
      continue
    }
    if (!row.booru_text.trim() && !row.nl_text.trim()) {
      empty += 1
      continue
    }
    const content = mergedContent(head?.content, row, merge)
    // Appending what the caption already says changes nothing: no new revision.
    if (sameContent(head?.content, content)) continue
    write.push({ path: row.path, content, source: resultSource(row), generation: head?.generation ?? 0 })
  }
  return { write, kept, empty }
}

/** A head as the tag step sees it, keyed like the entries. */
export function headKey(item: { item_type: 'library'; image_id: number } | { item_type: 'local'; path: string }): string {
  return item.item_type === 'library' ? libraryKey(item.image_id) : folderKey(item.path)
}
