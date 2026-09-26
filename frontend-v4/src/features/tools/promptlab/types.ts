// What /api/prompts/stats and /api/prompts/compare return (the routes have no
// response model, so the generated schema does not type them).

export type CheckpointEmptyReason =
  | 'no_checkpoint_metadata'
  | 'checkpoint_metadata_only_on_missing_files'
  | 'no_scored_images'
  | 'not_enough_scored_images_per_checkpoint'

export interface TagCount {
  tag: string
  count: number
  /** Share of the usable images (top tags only). */
  pct?: number
}

export interface CheckpointCount {
  name: string
  count: number
}

export interface CheckpointLeader extends CheckpointCount {
  avg_score: number
}

export interface CheckpointRecipe extends CheckpointCount {
  avg_score: number | null
  tags: string[]
}

export interface ScoredExample {
  id: number
  filename: string
  checkpoint: string | null
  prompt: string
  aesthetic_score: number
}

export interface TextLength {
  avg: number
  max: number
  min: number
  sample: number
  available?: boolean
}

export interface CheckpointCoverage {
  total_images: number
  usable_images: number
  images_with_checkpoint: number
  images_with_checkpoint_any: number
  scored_usable_images: number
  sd_attributed_images: number
  min_scored_images_per_checkpoint: number
}

export interface PromptStats {
  total_images: number
  usable_images: number
  tagged_images: number
  scored_images: number
  top_tags: TagCount[]
  top_tags_total: number
  top_tags_denominator: number
  high_aesthetic_tags: TagCount[]
  high_aesthetic_tags_total: number
  top_checkpoints: CheckpointCount[]
  top_checkpoints_total: number
  checkpoint_score_leaders: CheckpointLeader[]
  checkpoint_score_leaders_total: number
  checkpoint_recipes: CheckpointRecipe[]
  checkpoint_recipes_total: number
  top_scored_images: ScoredExample[]
  top_scored_images_total: number
  prompt_length: TextLength
  caption_length: TextLength
  checkpoint_coverage: CheckpointCoverage
  checkpoint_empty_action: 'scan_generated_images_folder' | null
  top_checkpoints_empty_reason: CheckpointEmptyReason | null
  checkpoint_score_leaders_empty_reason: CheckpointEmptyReason | null
  checkpoint_recipes_empty_reason: CheckpointEmptyReason | null
}

export interface CompareSide {
  id: number
  filename: string
  prompt: string
  checkpoint: string | null
  aesthetic_score: number | null
}

export interface CompareResult {
  image_a: CompareSide
  image_b: CompareSide
  tags_common: string[]
  tags_only_a: string[]
  tags_only_b: string[]
  prompt_common: string[]
  prompt_only_a: string[]
  prompt_only_b: string[]
}
