import type { components } from '../../../api/schema'

// What the style (artist) endpoints answer. One artist's images and the
// vocabulary check have response models (the schema types them); the rest are
// written here from routers/artists.py.

/** GET /api/artists/stats (the schema leaves the per-artist maps untyped). */
export interface ArtistStats {
  total_images: number
  /** Images with any result: confident + unconfirmed + no match. */
  identified_images: number
  undefined_count: number
  confident_count: number
  low_confidence_count: number
  confident_threshold: number
  /** Confident artists only. */
  artist_counts: Record<string, number>
  artist_stats?: Record<string, { count: number; avg_confidence: number; max_confidence: number }>
  low_confidence_artist_counts?: Record<string, number>
}

export type ArtistImagesPage = components['schemas']['ArtistImageListResponse']
export type ArtistImage = components['schemas']['ArtistImageResponse']
export type Vocabulary = components['schemas']['VocabularyResponse']

/** Kaloscope's tier for one result: only `high` names an artist. */
export type Tier = 'high' | 'low' | 'none'

/** GET /api/artists/diagnostics (only what the page reads). */
export interface ArtistDiagnostics {
  available?: boolean
  missing_dependencies?: string[] | null
}

/** POST /api/artists/identify-batch. */
export interface BatchStart {
  message: string
  total: number
  /** Images left out by skip_existing (they already have a result). */
  skipped?: number
  /** False when skip_existing left nothing to do. */
  started?: boolean
}

/** One image's result in GET /api/artists/batch-progress `results`. */
export interface BatchResult {
  image_id: number
  artist: string
  confidence: number
  confidence_level?: string | null
  candidate_artist?: string | null
}
