import { useQuery } from '@tanstack/react-query'
import { rawJson } from '../../../api/raw'
import { queryClient } from '../../../api/queryClient'
import { readBackground, type BackgroundState, type UnloadResult } from './background'

// Settings › Models › Background. Not in the generated schema yet, so called
// directly (GET and PATCH /api/background-models, POST .../unload).

export const BACKGROUND_KEY = ['background-models'] as const
const URL = '/api/background-models'
/** The loaded models are read again this often while the line is on screen. */
const REFRESH_MS = 5000

function answer(raw: unknown): BackgroundState {
  const state = readBackground(raw)
  if (!state) throw new Error('unreadable answer')
  return state
}

export function useBackgroundModels() {
  return useQuery({
    queryKey: BACKGROUND_KEY,
    queryFn: async ({ signal }) => answer(await rawJson<unknown>('GET', URL, { signal })),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
  })
}

/** How long an unused model stays loaded (minutes, 0 = never freed); answers with the new state. */
export async function saveIdleMinutes(minutes: number): Promise<BackgroundState> {
  const state = answer(await rawJson<unknown>('PATCH', URL, { body: { minutes } }))
  queryClient.setQueryData(BACKGROUND_KEY, state)
  return state
}

/** Free every loaded model no running job is using. */
export async function unloadModelsNow(): Promise<UnloadResult> {
  const raw = await rawJson<UnloadResult & Record<string, unknown>>('POST', `${URL}/unload`, { body: {} })
  const state = answer(raw)
  queryClient.setQueryData(BACKGROUND_KEY, state)
  return { ...state, released: Array.isArray(raw.released) ? raw.released.map(String) : [], busy: Array.isArray(raw.busy) ? raw.busy.map(String) : [] }
}
