import type { MessageKey } from '../../../i18n'
import type { Preset } from './types'
import { describingPresets, type VlmForm } from './vlmForm'

// Saved VLM prompt presets as plain values: which are the user's own, whether
// the boxes differ from one, what a save sends, and what a refusal means.
// The built-in presets are read-only; the backend refuses to change them.

/** GET /api/vlm/presets: the presets (built-in first) and why the user's own file could not be read ("" when fine). */
export interface PresetList {
  presets: Record<string, Preset>
  problem: string
}

/** The prompts V Opus writes with: every V Opus description is prose. */
export type PromptFields = Pick<Preset, 'system_prompt' | 'user_prompt' | 'user_prompt_with_tags'>

/** A preset made by the user (the list says so; one with no flag is a shipped one). */
export const isOwn = (preset: Preset | undefined): boolean => preset?.builtin === false

export interface Split {
  builtin: [string, Preset][]
  mine: [string, Preset][]
}

/** The presets V Opus can use, the shipped ones apart from the user's own. */
export function splitPresets(presets: Record<string, Preset>): Split {
  const usable = describingPresets(presets)
  return { builtin: usable.filter(([, p]) => !isOwn(p)), mine: usable.filter(([, p]) => isOwn(p)) }
}

export function promptFields(form: VlmForm): PromptFields {
  return { system_prompt: form.systemPrompt, user_prompt: form.userPrompt, user_prompt_with_tags: form.userPromptWithTags }
}

/** The boxes no longer say what the preset says. */
export function isEdited(form: VlmForm, preset: Preset | undefined): boolean {
  if (!preset) return false
  return (
    (preset.system_prompt ?? '') !== form.systemPrompt ||
    (preset.user_prompt ?? '') !== form.userPrompt ||
    (preset.user_prompt_with_tags ?? '') !== form.userPromptWithTags
  )
}

/** The name as the backend keeps it (blanks folded), so a rename to the same words is seen as no change. */
export function cleanName(name: string): string {
  return name.split(/\s+/).filter(Boolean).join(' ')
}

/** What a preset needs to be brought back after a delete (the same id, so the list does not shuffle). */
export function restoreBody(deleted: Preset): Record<string, unknown> {
  return {
    id: deleted.id,
    name: deleted.name,
    output_format: deleted.output_format ?? 'nl_caption',
    system_prompt: deleted.system_prompt ?? '',
    user_prompt: deleted.user_prompt ?? '',
    user_prompt_with_tags: deleted.user_prompt_with_tags ?? '',
  }
}

/** The user's own preset, if `name` is one of them (the backend compares without case or extra blanks). */
export function ownNamed(presets: Record<string, Preset>, name: string): [string, Preset] | undefined {
  const key = cleanName(name).toLowerCase()
  return Object.entries(presets).find(([, p]) => isOwn(p) && cleanName(p.name).toLowerCase() === key)
}

export type Refusal =
  | { kind: 'taken'; existingId: string; name: string }
  | { kind: 'text'; key: MessageKey }
  | { kind: 'raw'; message: string }

const REFUSALS: Record<string, MessageKey> = {
  vlm_preset_not_found: 'aipresets.err.gone',
  vlm_preset_builtin: 'aipresets.err.builtin',
  vlm_preset_name_required: 'aipresets.name.required',
  vlm_preset_file_unreadable: 'aipresets.err.unreadable',
  vlm_preset_file_busy: 'aipresets.err.busy',
}

/** What the backend's refusal means for the user (a name already used asks to replace; others say why). */
export function readRefusal(error: unknown): Refusal {
  // an ApiError (api/client.ts) carries the backend's code and its whole answer
  const { code, body } = error as { code?: unknown; body?: { params?: { existing_id?: unknown; name?: unknown } } | null }
  if (code === 'vlm_preset_name_taken') {
    const params = body?.params
    if (typeof params?.existing_id === 'string') return { kind: 'taken', existingId: params.existing_id, name: typeof params.name === 'string' ? params.name : '' }
  }
  const key = typeof code === 'string' ? REFUSALS[code] : undefined
  if (key) return { kind: 'text', key }
  return { kind: 'raw', message: error instanceof Error ? error.message : String(error) }
}
