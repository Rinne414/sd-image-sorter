// What the Model Center reads from /api/models/* (the routes have no response
// model, so the shapes are written out here, fields optional where the backend
// leaves them out for some cards).

/** One card of GET /api/models/status (services/model_service_inventory.py). */
export interface ModelCenterCard {
  id: string
  name?: string
  group?: string
  group_key?: string
  status?: string
  available?: boolean
  message?: string
  message_key?: string
  message_params?: Record<string, string | number>
  path?: string | null
  runtime_path?: string | null
  text_path?: string | null
  download_supported?: boolean
  recommended?: boolean
  /** WD14: every version the card can prepare; installed_variants: the ones on disk. */
  variants?: string[] | null
  installed_variants?: string[] | null
  default_variant?: string | null
  /** Where this card can download from (Kaloscope only). */
  sources?: string[] | null
  gated_download?: boolean
  requires_auth?: boolean
  external_links?: { label?: string; url?: string }[] | null
}

export interface ModelStatusResponse {
  models: ModelCenterCard[]
}

/** GET /api/models/mirror */
export interface MirrorState {
  mirror: string
  options?: string[]
}

/** GET /api/models/plan?model_id=… (restart_likely null: not known). */
export interface ModelPlan {
  model_id: string
  packages: string[]
  restart_likely: boolean | null
}

/** One entry of GET /api/models/bulk-bundle. */
export interface BulkItem {
  id: string
  label: string
  size_bytes: number
  status: 'ready' | 'missing'
  variant?: string | null
  feature_key?: string
  recommended?: boolean
  default_selected?: boolean
  requires_auth?: boolean
  gated_download?: boolean
  auth_url?: string | null
  restart_after_install?: boolean
  download_supported?: boolean
}

export interface BulkBundle {
  items: BulkItem[]
  excluded?: { id: string; reason?: string }[]
}
