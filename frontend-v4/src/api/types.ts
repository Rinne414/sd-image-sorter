// Response shapes the backend returns. Most FastAPI routes have no response
// model, so the generated schema types requests only; these fill the gap.

import type { components } from './schema'

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
  model_hash?: string | null
  /** Colour analysis (null until analysed): JSON [{hex, pct}], 0-255 averages, warm/cool/neutral, histogram shape. */
  dominant_colors?: string | null
  avg_brightness?: number | null
  color_saturation?: number | null
  color_temperature?: string | null
  brightness_distribution?: string | null
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
  /** The first four items, in order (a dataset batch: its first four Library images). */
  cover_image_ids: number[]
  /** A dataset batch's Dataset Maker project (null: other kinds, or the project was deleted). */
  dataset_project_id: number | null
  /** The linked project's revision (the CAS value for writing its items). */
  project_revision: number | null
  /** A dataset batch whose project V3.5 deleted: it can only be deleted. */
  orphaned: boolean
  /** The V3.5 collection a custom batch was made from. */
  source_collection_id: number | null
}

/** A V3.5 dataset project no batch shows yet (GET /api/batches). */
export interface UnlinkedDatasetProject {
  id: number
  name: string
  revision: number
  archived_at: string | null
  created_at: string
  updated_at: string
  item_count: number
  cover_image_ids: number[]
}

export interface BatchesResponse {
  batches: BatchSummary[]
  unlinked_dataset_projects: UnlinkedDatasetProject[]
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

/**
 * GET /api/batches/{id}: the batch with its items in order (a dataset batch's
 * live in its project). The dataset fields are optional here only so that
 * hand-built test batches of other kinds need not spell them out.
 */
export interface Batch extends Omit<BatchSummary, 'source_collection_id' | 'cover_image_ids' | 'project_revision' | 'orphaned'> {
  cover_image_ids?: number[]
  project_revision?: number | null
  orphaned?: boolean
  library_id: string
  steps: BatchStep[]
  settings: Record<string, unknown>
  items: BatchItem[]
}

export type DatasetProject = components['schemas']['DatasetProjectResponse']
export type DatasetProjectItem = DatasetProject['items'][number]
export type DatasetProjectItemRequest = components['schemas']['DatasetProjectUpdateRequest']['items'][number]

/** GET /api/batches/{id}/project: a dataset batch's project and the names of its Library images. */
export interface BatchProjectView {
  project: DatasetProject
  /** tagged: the tagger has run on the image (images.tagged_at is set). */
  library_images: { id: number; filename: string; width: number | null; height: number | null; tagged?: boolean }[]
  /** Folder images that live in the batch's uploads folder (deleted with the batch). */
  uploaded_count: number
}

/** One image POST /api/dataset/folder-scan or /upload-files surfaced. */
export interface ScannedImage {
  abs_path: string
  filename: string
  width?: number | null
  height?: number | null
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
