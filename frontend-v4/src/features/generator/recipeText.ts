import type { MessageKey, Params } from '../../i18n'
import { convertPrompt } from '../../lib/promptFormat'
import type { GeneratorRecipe, SeedMode, WorkflowSaved } from './generatorApi'

// What "Send to generator" copies and says. Pure: the dialog only shows these.

type Translate = (key: MessageKey, params?: Params) => string

/** The parts of an ApiError read here (checked by name, so this module needs no store to load). */
interface ApiErrorLike extends Error {
  code: string | null
  body: unknown
}

const isApiError = (error: unknown): error is ApiErrorLike => error instanceof Error && error.name === 'ApiError'

// ---- the texts to copy ----

/** Prompt, a "Negative prompt:" line and the settings line, the way WebUI reads them back. */
function composeWebui(prompt: string, negative: string, settingsLine: string): string {
  const parts = [prompt.trim()]
  if (negative.trim()) parts.push(`Negative prompt: ${negative.trim()}`)
  if (settingsLine) parts.push(settingsLine)
  return parts.join('\n').trim()
}

/** The picture's own WebUI text, else the prompt written in WebUI's weight syntax. */
export function webuiText(recipe: GeneratorRecipe, prompt: string | null, negative: string | null): string {
  if (recipe.source_format !== 'nai' || recipe.webui_is_original || prompt === null) return recipe.webui_text
  const sd = (text: string | null) => convertPrompt(text ?? '', 'nai', 'sd')
  return composeWebui(sd(prompt), sd(negative), recipe.webui_settings_line)
}

/** NovelAI's text (character slots included) for its own pictures, else the prompt written in NovelAI's syntax. */
export function naiText(recipe: GeneratorRecipe, prompt: string | null, negative: string | null): string {
  if (recipe.nai_text) return recipe.nai_text
  const nai = (text: string | null) => convertPrompt(text ?? '', 'sd', 'nai').trim()
  const blocks = [nai(prompt)]
  if (nai(negative)) blocks.push(`Undesired Content: ${nai(negative)}`)
  return blocks.filter(Boolean).join('\n\n')
}

// ---- what the picture holds for ComfyUI ----

export type ComfyKind = 'none' | 'full' | 'runOnly' | 'workflowOnly'

export function comfyKind(recipe: GeneratorRecipe): ComfyKind {
  const { has_api_prompt: run, has_workflow: workflow } = recipe.comfyui
  if (run && workflow) return 'full'
  if (run) return 'runOnly'
  return workflow ? 'workflowOnly' : 'none'
}

/** True when the picture offers nothing at all to send. */
export function hasNothing(recipe: GeneratorRecipe, webui: string, nai: string): boolean {
  return !recipe.has_prompt && !webui && !nai && comfyKind(recipe) === 'none'
}

/** The saved file's name and the folder it sits in. */
export function savedWhere(result: Pick<WorkflowSaved, 'path' | 'filename'>): { name: string; folder: string } {
  return { name: result.filename, folder: result.path.slice(0, Math.max(0, result.path.length - result.filename.length)) }
}

// ---- errors ----

const CODE_KEYS: Readonly<Record<string, MessageKey>> = {
  comfyui_address_spaces: 'generator.err.addressSpaces',
  comfyui_address_scheme: 'generator.err.addressScheme',
  comfyui_address_no_host: 'generator.err.addressNoHost',
  comfyui_address_extras: 'generator.err.addressExtras',
  comfyui_address_host: 'generator.err.addressHost',
  comfyui_address_port: 'generator.err.addressPort',
  comfyui_address_path: 'generator.err.addressPath',
  bad_address: 'generator.err.badAddress',
  comfyui_unreachable: 'generator.err.unreachable',
  comfyui_timeout: 'generator.err.timeout',
  comfyui_rejected: 'generator.err.rejected',
  comfyui_redirect: 'generator.err.redirect',
  comfyui_bad_answer: 'generator.err.badAnswer',
  image_not_found: 'generator.err.imageGone',
  workflow_write_failed: 'generator.err.writeFailed',
  settings_write_failed: 'generator.err.settingFailed',
}

export type Doing = 'queue' | 'save' | 'address' | 'read'

export interface Said {
  message: string
  /** ComfyUI's own node error lines, when it refused the recipe. */
  details: string[]
}

function bodyOf(error: unknown): { params: Params; details: string[]; message: string } {
  const body = isApiError(error) && error.body && typeof error.body === 'object' ? (error.body as Record<string, unknown>) : {}
  const params: Params = {}
  if (body.params && typeof body.params === 'object') {
    for (const [name, value] of Object.entries(body.params)) {
      if (typeof value === 'string' || typeof value === 'number') params[name] = value
    }
  }
  const details = Array.isArray(body.details) ? body.details.filter((d): d is string => typeof d === 'string') : []
  const message = error instanceof Error ? error.message : String(error)
  return { params, details, message }
}

/**
 * An error in the interface language. The server's code picks the sentence; a
 * code this page does not know shows the server's own words (never nothing).
 */
export function saidError(t: Translate, error: unknown, doing: Doing): Said {
  const code = isApiError(error) ? error.code : null
  const { params, details, message } = bodyOf(error)
  if (code === 'no_comfyui_recipe') return { message: t(doing === 'queue' ? 'generator.err.noRecipeRun' : 'generator.err.noRecipeSave'), details }
  const key = code ? CODE_KEYS[code] : undefined
  if (key) {
    // bad_address carries the reason as the server's message, not as a parameter.
    const filled: Params = key === 'generator.err.badAddress' ? { reason: message, ...params } : params
    return { message: t(key, filled), details }
  }
  return { message: t('generator.err.other', { reason: message }), details }
}

// ---- the seed choice, remembered ----

export const SEED_MODE_KEY = 'sd-v4-generator-seed-mode'

interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readSeedMode(store: KeyValueStore | null): SeedMode {
  try {
    return store?.getItem(SEED_MODE_KEY) === 'same' ? 'same' : 'new'
  } catch {
    return 'new'
  }
}

export function writeSeedMode(store: KeyValueStore | null, mode: SeedMode): void {
  try {
    store?.setItem(SEED_MODE_KEY, mode)
  } catch {
    // storage blocked: the choice simply is not remembered
  }
}
