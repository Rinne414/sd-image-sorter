import type { components } from '../../../api/schema'
import type { AiKey } from './aiText'
import type { Preset, Provider, TestResult, VlmSettings } from './types'

// The VLM form of Settings › AI services, as plain values. POST
// /api/vlm/settings changes only the fields it is sent, and an empty string
// wipes a stored secret: so the key and the service account are sent only
// when the user typed a new one, never empty, never the masked stand-in.
// The stored output format (description / tags / both) is never sent: only
// V3.5's batch captioning reads it, and V4's descriptions are always prose.

export type SaveBody = components['schemas']['SaveSettingsRequest']

export const PROVIDERS: readonly Provider[] = ['openai_compat', 'anthropic', 'gemini']
/** Where "Use" points a model Ollama runs on this computer. */
export const OLLAMA_ENDPOINT = 'http://localhost:11434/v1'
const DEFAULT_LOCATION = 'us-central1'

export interface VlmForm {
  provider: Provider
  endpoint: string
  /** A new key typed here; empty keeps the stored one. */
  apiKey: string
  model: string
  systemPrompt: string
  userPrompt: string
  userPromptWithTags: string
  includeTags: boolean
  maxRetries: string
  timeoutSeconds: string
  concurrent: string
  maxTokens: string
  temperature: string
  retryDelay: string
  maxImageSize: string
  nsfwRetryPrompt: string
  httpProxy: string
  httpsProxy: string
  socksProxy: string
  useVertex: boolean
  vertexProject: string
  vertexLocation: string
  /** A new service account JSON pasted here; empty keeps the stored one. */
  serviceAccountJson: string
}

type NumberKey = 'maxRetries' | 'timeoutSeconds' | 'concurrent' | 'maxTokens' | 'temperature' | 'retryDelay' | 'maxImageSize'

interface NumberField {
  key: NumberKey
  body: 'max_retries' | 'timeout_seconds' | 'concurrent_requests' | 'caption_max_tokens' | 'caption_temperature' | 'retry_delay_seconds' | 'max_image_size'
  label: AiKey
  /** The backend's own default and range (routers/vlm_models.py, routers/vlm.py _build_config). */
  fallback: number
  min: number
  max: number
  whole: boolean
}

export const NUMBER_FIELDS: readonly NumberField[] = [
  { key: 'maxRetries', body: 'max_retries', label: 'ai.adv.retries', fallback: 3, min: 0, max: 10, whole: true },
  { key: 'timeoutSeconds', body: 'timeout_seconds', label: 'ai.adv.timeout', fallback: 60, min: 1, max: 600, whole: false },
  { key: 'concurrent', body: 'concurrent_requests', label: 'ai.adv.concurrent', fallback: 2, min: 1, max: 16, whole: true },
  { key: 'maxTokens', body: 'caption_max_tokens', label: 'ai.adv.maxTokens', fallback: 1024, min: 64, max: 8192, whole: true },
  { key: 'temperature', body: 'caption_temperature', label: 'ai.adv.temperature', fallback: 0.3, min: 0, max: 2, whole: false },
  { key: 'retryDelay', body: 'retry_delay_seconds', label: 'ai.adv.retryDelay', fallback: 2, min: 0, max: 60, whole: false },
  { key: 'maxImageSize', body: 'max_image_size', label: 'ai.adv.maxImage', fallback: 1024, min: 128, max: 4096, whole: true },
]

const text = (v: unknown) => (typeof v === 'string' ? v : '')
const asProvider = (v: unknown): Provider => (PROVIDERS.includes(v as Provider) ? (v as Provider) : 'openai_compat')
const numberText = (v: unknown, fallback: number) => String(typeof v === 'number' && Number.isFinite(v) ? v : fallback)

export function formFromSettings(s: VlmSettings): VlmForm {
  const n = (key: NumberKey) => {
    const field = NUMBER_FIELDS.find((f) => f.key === key) as NumberField
    return numberText(s[field.body], field.fallback)
  }
  return {
    provider: asProvider(s.provider),
    endpoint: text(s.endpoint),
    apiKey: '',
    model: text(s.model),
    systemPrompt: text(s.system_prompt),
    userPrompt: text(s.user_prompt),
    userPromptWithTags: text(s.user_prompt_with_tags),
    includeTags: s.include_tags_as_context ?? true,
    maxRetries: n('maxRetries'),
    timeoutSeconds: n('timeoutSeconds'),
    concurrent: n('concurrent'),
    maxTokens: n('maxTokens'),
    temperature: n('temperature'),
    retryDelay: n('retryDelay'),
    maxImageSize: n('maxImageSize'),
    nsfwRetryPrompt: text(s.nsfw_retry_prompt),
    httpProxy: text(s.http_proxy),
    httpsProxy: text(s.https_proxy),
    socksProxy: text(s.socks_proxy),
    useVertex: s.use_vertex === true,
    vertexProject: text(s.vertex_project),
    vertexLocation: text(s.vertex_location) || DEFAULT_LOCATION,
    serviceAccountJson: '',
  }
}

export type FormError = { key: 'ai.range'; field: AiKey; min: number; max: number } | { key: 'ai.needHttp' }
export type BuildResult = { ok: true; body: SaveBody } | { ok: false; error: FormError }

/** A value the backend shows in place of a secret (never to be sent back as one). */
const isMasked = (v: string) => v.includes('***') || v.includes('•')

/** A secret to send: only something newly typed, never empty or masked. */
function freshSecret(v: string): string | null {
  const trimmed = v.trim()
  return trimmed && !isMasked(trimmed) ? trimmed : null
}

function parseNumber(raw: string, field: NumberField): number | null {
  const n = Number(raw.trim())
  if (raw.trim() === '' || !Number.isFinite(n) || n < field.min || n > field.max) return null
  if (field.whole && !Number.isInteger(n)) return null
  return n
}

/** The POST /api/vlm/settings body, or the first thing the backend would refuse. */
export function settingsBody(form: VlmForm): BuildResult {
  const endpoint = form.endpoint.trim()
  if (endpoint && !/^https?:\/\//i.test(endpoint)) return { ok: false, error: { key: 'ai.needHttp' } }
  const numbers: Partial<Record<NumberField['body'], number>> = {}
  for (const field of NUMBER_FIELDS) {
    const n = parseNumber(form[field.key], field)
    if (n === null) return { ok: false, error: { key: 'ai.range', field: field.label, min: field.min, max: field.max } }
    numbers[field.body] = n
  }
  const body: SaveBody = {
    provider: form.provider,
    endpoint,
    model: form.model.trim(),
    system_prompt: form.systemPrompt,
    user_prompt: form.userPrompt,
    user_prompt_with_tags: form.userPromptWithTags,
    include_tags_as_context: form.includeTags,
    nsfw_retry_prompt: form.nsfwRetryPrompt,
    http_proxy: form.httpProxy.trim(),
    https_proxy: form.httpsProxy.trim(),
    socks_proxy: form.socksProxy.trim(),
    use_vertex: form.useVertex,
    vertex_project: form.vertexProject.trim(),
    vertex_location: form.vertexLocation.trim() || DEFAULT_LOCATION,
    ...numbers,
  }
  const key = freshSecret(form.apiKey)
  if (key) body.api_key = key
  const account = freshSecret(form.serviceAccountJson)
  if (account) body.service_account_json = account
  return { ok: true, body }
}

/** The backend recognised `endpoint` as `provider`: apply it if the address still reads so. */
export function withDetectedProvider(form: VlmForm, endpoint: string, provider: string): VlmForm {
  if (form.endpoint.trim() !== endpoint || !PROVIDERS.includes(provider as Provider) || form.provider === provider) return form
  return { ...form, provider: provider as Provider }
}

export function applyPreset(form: VlmForm, preset: Preset): VlmForm {
  return {
    ...form,
    systemPrompt: preset.system_prompt ?? '',
    userPrompt: preset.user_prompt ?? '',
    userPromptWithTags: preset.user_prompt_with_tags ?? '',
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/** A server on this computer or the local network: calls cost nothing and need no key. */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint.trim()).hostname.toLowerCase()
    return LOCAL_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.lan')
  } catch {
    return false
  }
}

/** The stored settings point at `model` on the Ollama of this computer. */
export function usesOllamaModel(s: VlmSettings, model: string): boolean {
  try {
    const url = new URL(text(s.endpoint).trim())
    return LOCAL_HOSTS.has(url.hostname.toLowerCase()) && url.port === '11434' && text(s.model).trim() === model
  } catch {
    return false
  }
}

export interface VlmReadiness {
  /** Descriptions can be asked for (what the backend checks before a run). */
  ready: boolean
  /** Runs on this computer: free. */
  local: boolean
  /** The model, or the service type when no model is filled in. */
  label: string
  missing: 'endpoint' | 'key' | null
}

export function vlmReadiness(s: VlmSettings): VlmReadiness {
  const provider = asProvider(s.provider)
  const endpoint = text(s.endpoint).trim()
  const label = text(s.model).trim() || provider
  if (provider === 'gemini' && s.use_vertex === true) {
    const ready = text(s.vertex_project).trim() !== ''
    return { ready, local: false, label, missing: ready ? null : 'endpoint' }
  }
  if (!endpoint) return { ready: false, local: false, label, missing: 'endpoint' }
  const local = provider === 'openai_compat' && isLocalEndpoint(endpoint)
  if (!local && !s.api_key_display) return { ready: false, local, label, missing: 'key' }
  return { ready: true, local, label, missing: null }
}

export function isDirty(form: VlmForm, baseline: VlmForm): boolean {
  return (Object.keys(form) as (keyof VlmForm)[]).some((k) => form[k] !== baseline[k])
}

export interface Outcome {
  ok: boolean
  key: AiKey
  params: Record<string, string | number>
}

const WHY: Record<string, AiKey> = {
  auth: 'ai.why.auth',
  timeout: 'ai.why.timeout',
  connection: 'ai.why.connection',
  network: 'ai.why.network',
  rate_limit: 'ai.why.rate_limit',
  server_error: 'ai.why.server_error',
  config: 'ai.why.config',
}

/** What "Test connection" says. `params.why` is a key to translate. */
export function testOutcome(result: TestResult): Outcome {
  if (result.status === 'ok') {
    const n = result.models?.length ?? 0
    return n > 0 ? { ok: true, key: 'ai.test.ok', params: { n } } : { ok: true, key: 'ai.test.okNoList', params: {} }
  }
  const why = WHY[result.error_type ?? ''] ?? 'ai.why.unknown'
  const reason = (result.error ?? '').trim()
  return reason ? { ok: false, key: 'ai.test.failDetail', params: { why, reason } } : { ok: false, key: 'ai.test.fail', params: { why } }
}
