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

export interface CollectionRow {
  id: number
  name: string
  kind?: string | null
  is_system?: boolean | number | null
  image_count?: number | null
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
