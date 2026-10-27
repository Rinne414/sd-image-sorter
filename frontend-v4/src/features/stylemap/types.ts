// The answers of /api/style-map/* (backend/routers/style_map.py, docs/API.md
// "Style Map"). The generated schema has none of these routes, so they are
// written by hand and called through api/raw.ts.

/** What places the pictures: the Style Finder model, the similarity model, or CSD. */
export type Space = 'kaloscope' | 'clip' | 'csd'

export const SPACES: readonly Space[] = ['kaloscope', 'clip', 'csd']

/** The data field the dots are coloured by. */
export type ColorBy = 'generator' | 'folder' | 'artist' | 'aesthetic_score' | 'aesthetic_waifu' | 'aesthetic_anime'

export const COLOR_FIELDS: readonly ColorBy[] = ['generator', 'folder', 'artist', 'aesthetic_score', 'aesthetic_waifu', 'aesthetic_anime']

/** The optional UMAP fit next to the quick PCA layout. */
export type UmapStatus = 'unavailable' | 'too_few_points' | 'not_started' | 'queued' | 'computing' | 'ready' | 'failed'

export interface UmapState {
  status?: string
  error?: string | null
}

/** One dot: [picture id, x, y, z, pictures it stands for] (`points_layout` names the columns). */
export type PointRow = number[]

export interface PointsAnswer {
  /** ok, empty (the filter matches nothing) or no_vectors (nothing indexed yet). */
  status: string
  space?: string
  /** pca, or umap once the fit is ready. */
  method?: string
  total_images?: number
  missing_vectors?: number
  unlocatable?: number[]
  merged_away?: number
  points_layout?: string[]
  points?: PointRow[]
  umap?: UmapState
  /** Names this cached map in every later request. */
  map_id?: string
}

export interface LayoutStatusAnswer {
  method?: string
  umap?: UmapState
}

export interface LegendEntry {
  key: string
  label?: string | null
  count: number
}

export interface ColorsAnswer {
  status: string
  by?: string
  /** category: an index into `legend`; scale: a number within `range`. */
  kind?: 'category' | 'scale'
  ids?: number[]
  values?: (number | null)[]
  legend?: LegendEntry[]
  range?: [number, number] | null
  missing?: number
}

export interface RegionTag {
  tag: string
}

export interface RegionArtist {
  artist: string
  count: number
  high_total: number
}

export interface Region {
  id: number
  center: [number, number, number]
  size?: number
  members_total?: number
  representatives?: number[]
  tags?: RegionTag[]
  artists?: RegionArtist[]
}

export interface RegionsAnswer {
  status: string
  method?: string
  regions?: Region[]
}

export interface AxisEnd {
  representatives?: number[]
  tags?: RegionTag[]
}

export interface AxisEntry {
  low?: AxisEnd
  high?: AxisEnd
  weak?: boolean
}

export type AxisName = 'x' | 'y' | 'z'

export const AXIS_NAMES: readonly AxisName[] = ['x', 'y', 'z']

export interface AxesAnswer {
  status: string
  axes?: Partial<Record<AxisName, AxisEntry>>
}

export interface XYZ {
  x: number
  y: number
  z: number
}

export interface Neighbour extends Partial<XYZ> {
  id: number
  filename?: string | null
  score: number
  weak?: boolean
  in_filter?: boolean
  located?: boolean
  merged?: boolean
}

/** Where a library picture is on the map (GET /near only). */
export interface SelfPlace extends Partial<XYZ> {
  in_filter?: boolean
  located?: boolean
  merged?: boolean
  filename?: string | null
}

export interface NearAnswer {
  /** ok, no_vector (the picture has none in this space) or not_started (the map was lost). */
  status: string
  query?: XYZ | null
  neighbors?: Neighbour[]
  weak_threshold?: number
  self?: SelfPlace | null
}

export interface LocateResult extends XYZ {
  id: number
  filename?: string | null
  merged?: boolean
}

export interface LocateAnswer {
  status: string
  results?: LocateResult[]
  total?: number
  outside_filter?: number
  without_data?: number
}

export interface MembersAnswer {
  status: string
  ids?: number[]
}
