import type { paths } from '../../../../api/schema'
import { DEFAULT_WEIGHT, type Setup } from './slots'

// What one /api/prompts/generate call carries. V3.5 sent quality 'none', no
// negative and no tag sets whatever the user wanted (pain point 8); here every
// option the backend takes is sent. One call writes one prompt: several
// prompts are several draws, each with its own seed.

export type GenerateConfig = paths['/api/prompts/generate']['post']['requestBody']['content']['application/json']

export type Quality = 'high' | 'medium' | 'none'

export interface GenerateOptions {
  quality: Quality
  negative: boolean
  /** Tag-set ids (built-in ones are text, the user's are numbers written as text). */
  tagSets: string[]
}

export function generateBody(setup: Setup, opts: GenerateOptions, seed: number): GenerateConfig {
  const categories: NonNullable<GenerateConfig['categories']> = {}
  for (const [cat, tags] of Object.entries(setup.slots)) {
    if (!tags.length) continue
    categories[cat] = { tags, weight: (setup.weights[cat] ?? DEFAULT_WEIGHT) / 100, locked: !!setup.locked[cat] }
  }
  return {
    categories,
    tag_sets: [...opts.tagSets],
    quality_preset: opts.quality,
    include_negative: opts.negative,
    // no "1girl" of its own: the slots say who is in the picture
    count_tag: '',
    // only the backend's own automatic picks read this; the slots are the user's
    nsfw: false,
    seed,
    count: 1,
  }
}
