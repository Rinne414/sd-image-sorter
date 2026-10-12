// What the /api/vlm/* routes answer (they declare no response models).

export type Provider = 'openai_compat' | 'anthropic' | 'gemini'

/**
 * GET /api/vlm/settings: the stored settings. The key and the service account
 * never come back; only a masked stand-in says one is stored.
 */
export interface VlmSettings {
  provider?: string
  endpoint?: string
  api_key_display?: string
  model?: string
  max_retries?: number
  retry_delay_seconds?: number
  timeout_seconds?: number
  concurrent_requests?: number
  system_prompt?: string
  user_prompt?: string
  user_prompt_with_tags?: string
  include_tags_as_context?: boolean
  max_image_size?: number
  nsfw_retry_prompt?: string
  output_format?: string
  caption_max_tokens?: number
  caption_temperature?: number
  http_proxy?: string
  https_proxy?: string
  socks_proxy?: string
  use_vertex?: boolean
  vertex_project?: string
  vertex_location?: string
  service_account_json_display?: string
}

/** GET /api/vlm/presets → presets[id]. */
export interface Preset {
  name: string
  output_format?: string
  system_prompt?: string
  user_prompt?: string
  user_prompt_with_tags?: string
}

/** POST /api/vlm/test: the provider's own verdict (a failure still answers 200). */
export interface TestResult {
  status: 'ok' | 'error'
  models?: string[]
  note?: string
  error?: string
  error_type?: string
}

/** POST /api/vlm/probe-concurrency. */
export interface ProbeResult {
  status: 'ok' | 'error'
  recommended: number
  applied: boolean
  message?: string
}

/** One Ollama model the app recommends. */
export interface RecommendedModel {
  id: string
  name: string
  size_gb: number
  vram_min_gb: number
  description: string
  nsfw_ok: boolean
  installed: boolean
}

/** One model already in Ollama. */
export interface LocalModel {
  id: string
  size_gb: number
  modified_at?: string
}

/** GET /api/vlm/local-models/recommended. */
export interface LocalModels {
  ollama_installed: boolean
  ollama_running: boolean
  install_instructions?: string | null
  models: RecommendedModel[]
  local_models: LocalModel[]
}

/** One entry of GET /api/vlm/caption-batch/debug-chat. */
export interface ChatEvent {
  id: number
  at?: string
  phase?: string
  image_id?: number | null
  image_name?: string
  provider?: string
  model?: string
  latency_ms?: number
  tokens_used?: number
  system_prompt?: string
  user_prompt?: string
  tags?: string[]
  caption?: string
  raw_text?: string
  error?: string
  error_type?: string
}
