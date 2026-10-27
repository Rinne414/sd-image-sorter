import { displayTag } from '../batch/edit/tagStyle'

// The quick lists next to the tag dialog's blacklist box. The two lists are the
// ones the classic page offers (frontend/js/tag-power.js, aligned with the
// backend's Smart Tag noise vocabularies); blacklistPresets.test.ts reads that
// file and fails when the two drift apart.

/** Quality words: the ones a prompt adds and an image tagger has no use for. */
export const QUALITY_TAGS: readonly string[] = [
  'masterpiece', 'best_quality', 'good_quality', 'normal_quality',
  'low_quality', 'worst_quality', 'high_quality', 'lowres', 'highres',
  'absurdres',
  'score_9', 'score_8', 'score_7', 'score_6', 'score_5', 'score_4',
  'score_9_up', 'score_8_up', 'score_7_up', 'score_6_up',
]

/** Marks on the picture itself rather than what it shows. */
export const META_TAGS: readonly string[] = [
  'signature', 'watermark', 'jpeg_artifacts', 'official_art',
  'sketch', 'monochrome', 'greyscale', 'grayscale',
  'censored', 'mosaic_censoring', 'bar_censor',
]

export type BlacklistPreset = 'quality' | 'meta'

export const PRESET_TAGS: Readonly<Record<BlacklistPreset, readonly string[]>> = { quality: QUALITY_TAGS, meta: META_TAGS }

const entries = (text: string): string[] =>
  text
    .split(/[,\n，]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** How two spellings of one tag compare: `blue_sky`, `Blue Sky` and `blue sky` are one. */
const same = (tag: string): string => tag.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * The box text with the preset's tags added after the ones already there:
 * written the way the box writes tags (spaces; `score_` keeps its underscores),
 * and a tag already in the box, in any spelling, is not added twice.
 */
export function withPreset(text: string, preset: BlacklistPreset): string {
  const have = entries(text)
  const seen = new Set(have.map(same))
  const added: string[] = []
  for (const tag of PRESET_TAGS[preset]) {
    const written = displayTag(tag)
    if (seen.has(same(written))) continue
    seen.add(same(written))
    added.push(written)
  }
  return [...have, ...added].join(', ')
}

/** How many of the preset's tags the box does not have yet (0: pressing it changes nothing). */
export function missingFrom(text: string, preset: BlacklistPreset): number {
  const seen = new Set(entries(text).map(same))
  return PRESET_TAGS[preset].filter((tag) => !seen.has(same(displayTag(tag)))).length
}
