import type { ImageQueryParams } from './searchQuery'

// The gallery list (GET /api/images) takes snake_case query params with
// comma-joined lists; the "every match" endpoints (POST selection-ids, count,
// selection-token) take the same filters as a camelCase JSON body with real
// lists. One table maps between them. A key missing here must fail loudly:
// dropping a filter would silently widen a move or delete to more images.

type Field = { to: string; list?: true }

const FIELDS: Record<string, Field> = {
  sort_by: { to: 'sortBy' },
  search: { to: 'search' },
  tags: { to: 'tags', list: true },
  exclude_tags: { to: 'excludeTags', list: true },
  checkpoints: { to: 'checkpoints', list: true },
  exclude_checkpoints: { to: 'excludeCheckpoints', list: true },
  loras: { to: 'loras', list: true },
  exclude_loras: { to: 'excludeLoras', list: true },
  prompts: { to: 'prompts', list: true },
  exclude_prompts: { to: 'excludePrompts', list: true },
  generators: { to: 'generators', list: true },
  exclude_generators: { to: 'excludeGenerators', list: true },
  ratings: { to: 'ratings', list: true },
  exclude_ratings: { to: 'excludeRatings', list: true },
  exclude_colors: { to: 'excludeColors', list: true },
  color_hues: { to: 'colorHues', list: true },
  exclude_color_hues: { to: 'excludeColorHues', list: true },
  min_aesthetic: { to: 'minAesthetic' },
  max_aesthetic: { to: 'maxAesthetic' },
  aesthetic_unscored: { to: 'aestheticUnscored' },
  min_user_rating: { to: 'minUserRating' },
  min_width: { to: 'minWidth' },
  max_width: { to: 'maxWidth' },
  min_height: { to: 'minHeight' },
  max_height: { to: 'maxHeight' },
  aspect_ratio: { to: 'aspectRatio' },
  color_temperature: { to: 'colorTemperature' },
  brightness_distribution: { to: 'brightnessDistribution' },
  brightness_min: { to: 'brightnessMin' },
  brightness_max: { to: 'brightnessMax' },
  min_saturation: { to: 'minSaturation' },
  max_saturation: { to: 'maxSaturation' },
  seed: { to: 'seed' },
  date_from: { to: 'dateFrom' },
  date_to: { to: 'dateTo' },
  artist: { to: 'artist' },
  folder: { to: 'folder' },
  has_metadata: { to: 'hasMetadata' },
  no_caption: { to: 'noCaption' },
  collection_id: { to: 'collectionId' },
}

export type SelectionBody = Record<string, string | number | boolean | string[]>

/** The gallery's current params as the body of POST /api/images/selection-ids. */
export function toSelectionBody(params: ImageQueryParams): SelectionBody {
  const body: SelectionBody = {}
  for (const [key, value] of Object.entries(params)) {
    const field = FIELDS[key]
    if (!field) throw new Error(`selection body: no mapping for filter "${key}"`)
    body[field.to] = field.list
      ? String(value)
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : value
  }
  return body
}
