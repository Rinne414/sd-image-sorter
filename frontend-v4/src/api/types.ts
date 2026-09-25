// Response shapes the backend returns. Most FastAPI routes have no response
// model, so the generated schema types requests only; these fill the gap.

export interface ImageSummary {
  id: number
  filename: string
  path: string
  generator: string | null
  width: number | null
  height: number | null
  file_size: number | null
  checkpoint: string | null
  checkpoint_normalized: string | null
  loras: string | null
  user_rating: number | null
  aesthetic_score: number | null
  is_readable: number | null
  metadata_status: string | null
  created_at: string | null
  library_order_time: string | null
}

export interface ImagesPage {
  images: ImageSummary[]
  next_cursor: string | null
  next_offset: number | null
  has_more: boolean
  total: number
}

export interface ImageTag {
  tag: string
  confidence: number | null
  source: string | null
  category: string | null
}

export interface ImageDetail extends ImageSummary {
  prompt: string | null
  negative_prompt: string | null
  metadata_json: string | null
  ai_caption: string | null
  nl_caption: string | null
  sidecar_caption: string | null
  tagged_at: string | null
}

export interface ImageDetailResponse {
  image: ImageDetail
  tags: ImageTag[]
}

export interface Library {
  id: string
  name: string
  created_at: string | null
  is_default: boolean
  image_count: number
}

export interface LibrariesResponse {
  libraries: Library[]
  current_id: string
}

export interface GeneratorCount {
  generator: string
  count: number
}

/** A V3.5 collection (GET /api/collections); "favorites" is the built-in one. */
export interface CollectionRow {
  id: number
  slug: string
  name: string
  folder_path: string | null
  created_at: string | null
  item_count: number
}

export type BatchKind = 'pixiv' | 'dataset' | 'custom'

export interface BatchStep {
  id: string
  enabled: boolean
}

/** One row of GET /api/batches. */
export interface BatchSummary {
  id: number
  kind: BatchKind
  name: string
  current_step: string | null
  revision: number
  archived_at: string | null
  created_at: string
  updated_at: string
  item_count: number
  censored_count: number
  /** The first four items, in order. */
  cover_image_ids: number[]
}

export interface BatchItem {
  image_id: number
  position: number
  filename: string
  width: number | null
  height: number | null
  output_name: string | null
  has_censored: boolean
  censored_at: string | null
  item_state: Record<string, unknown> | null
}

/** GET /api/batches/{id}: the batch with its items in order. */
export interface Batch extends Omit<BatchSummary, 'cover_image_ids'> {
  library_id: string
  steps: BatchStep[]
  settings: Record<string, unknown>
  dataset_project_id: number | null
  items: BatchItem[]
}

export interface BatchTemplate {
  id: number
  kind: BatchKind
  name: string
  steps: BatchStep[]
  settings: Record<string, unknown>
  created_at: string
}

export interface BatchTemplatesResponse {
  templates: BatchTemplate[]
  builtin_steps: Record<BatchKind, BatchStep[]>
}

export interface LibraryHealth {
  summary: {
    total_images: number
    readable_images: number
    tagged_percent: number
    actionable_count: number
  }
  issue_counts: Record<string, number>
}

export interface MissingSummary {
  total: number
}

export type TagCategory =
  | 'character'
  | 'artist'
  | 'body'
  | 'expression'
  | 'outfit'
  | 'pose'
  | 'angle'
  | 'action'
  | 'background'
  | 'style'
  | 'quality'
  | 'meta'
  | 'rating'
  | 'unknown'

export interface CategorizeResponse {
  results: { tag: string; category: TagCategory }[]
}
