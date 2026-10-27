import { rawJson } from '../../../api/raw'
import { queryClient } from '../../../api/queryClient'
import { PRESETS_KEY } from './aiApi'
import type { PromptFields } from './presets'
import type { Preset } from './types'

// Saving, changing and deleting the user's own prompt presets
// (POST|PATCH|DELETE /api/vlm/presets). These routes are not in the generated
// schema yet, so they go through rawJson (same library header, same errors).

const URL = '/api/vlm/presets'
const one = (id: string) => `${URL}/${encodeURIComponent(id)}`

const refresh = () => queryClient.invalidateQueries({ queryKey: PRESETS_KEY })

/** Save the prompts as a new preset; resolves to what was stored. */
export async function createPreset(name: string, fields: PromptFields): Promise<Preset> {
  const { preset } = await rawJson<{ preset: Preset }>('POST', URL, { body: { name, output_format: 'nl_caption', ...fields } })
  await refresh()
  return preset
}

/** Bring a deleted preset back as it was (the same id). */
export async function restorePreset(body: Record<string, unknown>): Promise<Preset> {
  const { preset } = await rawJson<{ preset: Preset }>('POST', URL, { body })
  await refresh()
  return preset
}

/** Put the prompts into an existing preset of the user's. Only the prompts are sent; its output format stays. */
export async function updatePreset(id: string, fields: PromptFields): Promise<Preset> {
  const { preset } = await rawJson<{ preset: Preset }>('PATCH', one(id), { body: fields })
  await refresh()
  return preset
}

export async function renamePreset(id: string, name: string): Promise<Preset> {
  const { preset } = await rawJson<{ preset: Preset }>('PATCH', one(id), { body: { name } })
  await refresh()
  return preset
}

/** Delete a preset of the user's; resolves to it, so Undo can bring it back. */
export async function deletePreset(id: string): Promise<Preset> {
  const { deleted } = await rawJson<{ deleted: Preset }>('DELETE', one(id))
  await refresh()
  return deleted
}
