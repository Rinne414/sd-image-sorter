import { useQuery } from '@tanstack/react-query'
import { rawJson } from '../../api/raw'
import { queryClient } from '../../api/queryClient'

// Send to generator: a picture's recipe, the ComfyUI address, and the two ways
// to use a ComfyUI recipe (save it as a .json, queue it). These routes are not
// in the generated schema, so they go through api/raw.ts.

export interface ComfyRecipePart {
  has_api_prompt: boolean
  has_workflow: boolean
  seed_inputs: number
  workflow: unknown
}

export interface GeneratorRecipe {
  image_id: number
  generator: string
  source_format: 'sd' | 'nai'
  has_prompt: boolean
  webui_text: string
  webui_is_original: boolean
  webui_settings_line: string
  nai_text: string
  /** Where the picture's details were read: its file, the copy kept in the library, or nowhere. */
  metadata_source: 'file' | 'stored' | null
  comfyui: ComfyRecipePart
  comfyui_url: string | null
}

export interface ComfySetting {
  /** The address in force now; null when the saved one cannot be used. */
  url: string | null
  /** What the user typed ('' = the default). */
  custom_url: string
  default_url: string
}

export interface WorkflowSaved {
  saved: true
  path: string
  filename: string
  kind: 'workflow' | 'api_prompt'
}

export interface QueuedRun {
  prompt_id: string
  comfyui_url: string
  seed_mode: 'new' | 'same'
  seeds_changed: number
}

export type SeedMode = 'new' | 'same'

const recipeKey = (id: number) => ['generator-recipe', id] as const
const SETTING_KEY = ['comfyui-setting'] as const

export function useGeneratorRecipe(id: number) {
  return useQuery({
    queryKey: recipeKey(id),
    queryFn: ({ signal }) => rawJson<GeneratorRecipe>('GET', `/api/images/${id}/generator-recipe`, { signal }),
    // The file can change between two openings (a re-read, a new run): read it fresh each time.
    staleTime: 0,
    gcTime: 30_000,
    retry: false,
  })
}

export function useComfySetting() {
  return useQuery({
    queryKey: SETTING_KEY,
    queryFn: ({ signal }) => rawJson<ComfySetting>('GET', '/api/settings/comfyui', { signal }),
    staleTime: 0,
    retry: false,
  })
}

/** Save the address ('' = the default); the answer is the setting as stored. */
export async function saveComfyAddress(url: string): Promise<ComfySetting> {
  const setting = await rawJson<ComfySetting>('PATCH', '/api/settings/comfyui', { body: { url } })
  queryClient.setQueryData(SETTING_KEY, setting)
  void queryClient.invalidateQueries({ queryKey: ['generator-recipe'] })
  return setting
}

export function saveWorkflowFile(id: number): Promise<WorkflowSaved> {
  return rawJson<WorkflowSaved>('POST', `/api/images/${id}/comfyui/workflow-file`, { body: {} })
}

export function queueInComfy(id: number, seedMode: SeedMode): Promise<QueuedRun> {
  return rawJson<QueuedRun>('POST', `/api/images/${id}/comfyui/queue`, { body: { seed_mode: seedMode } })
}
