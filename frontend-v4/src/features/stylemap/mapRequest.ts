import { parseSearch, toImageParams, type ImageQueryParams } from '../../lib/searchQuery'
import { toSelectionBody, type SelectionBody } from '../../lib/selectionBody'
import type { Space } from './types'

// The query strings and bodies of the map's requests. The map's scope is the
// library's current filter (the same search the library page shows), sent as
// a selection token; the map handle (`map_id`) of a points answer names that
// cached map in every later request.

/** The Style Finder model settings the Kaloscope map reads (shared with the Style Finder tool). */
export interface ModelChoice {
  model_source: 'huggingface' | 'modelscope' | 'local'
  model_path: string | null
}

export interface MapScope {
  space: Space
  /** The library filter as a selection token; null maps the whole library. */
  token: string | null
  model: ModelChoice
}

/**
 * The query of a map request. Only the Kaloscope space has weights to name:
 * the CLIP and CSD maps stay up when a local Style Finder file is gone.
 */
export function mapQuery(scope: MapScope, extra: Record<string, string | number | boolean | null | undefined> = {}): string {
  const params = new URLSearchParams({ space: scope.space })
  if (scope.token) params.set('selection_token', scope.token)
  if (scope.space === 'kaloscope') {
    params.set('model_source', scope.model.model_source)
    if (scope.model.model_source === 'local' && scope.model.model_path) params.set('model_path', scope.model.model_path)
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === undefined) continue
    params.set(key, String(value))
  }
  return params.toString()
}

/** A request for the cached map named by `mapId`: the (long) filter token is left out. */
export function cachedMapQuery(scope: MapScope, mapId: string, extra: Record<string, string | number | boolean | null | undefined> = {}): string {
  return mapQuery({ ...scope, token: null }, { map_id: mapId, ...extra })
}

/** What a lookup is keyed by: the space, the map and its coordinates. */
export const mapSignature = (space: Space, mapId: string | undefined, method: string | undefined): string => `${space}|${mapId ?? ''}|${method ?? ''}`

/** Only the set of pictures matters: a random library order has no stable token, so the map asks for a fixed one. */
export function scopeParams(params: ImageQueryParams): ImageQueryParams {
  return { ...params, sort_by: 'newest' }
}

/** True when the params narrow the library (anything besides the order). */
export const isFiltered = (params: ImageQueryParams): boolean => Object.keys(params).some((key) => key !== 'sort_by')

const WHOLE_LIBRARY = { generators: [], folder: null, favoritesCollectionId: null }

/**
 * The "find a picture" text through the library's search language: the
 * selection-token body of what it names, and the parts it did not
 * understand. `body` is null when nothing but misunderstood parts was typed.
 */
export function searchBody(text: string): { body: SelectionBody | null; ignored: string[] } {
  const parsed = parseSearch(text)
  const ignored = parsed.parts.filter((p) => p.kind === 'warn').map((p) => (p.kind === 'warn' ? p.raw : ''))
  if (parsed.parts.length > 0 && parsed.parts.every((p) => p.kind === 'warn')) return { body: null, ignored }
  return { body: toSelectionBody(toImageParams(parsed, WHOLE_LIBRARY, 'newest')), ignored }
}
