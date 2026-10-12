import { api, unwrap } from '../../api/client'
import type { SlotKey, SlotMap } from './sortSession'
import type { startBody } from './savedSetup'

// The manual sort session endpoints (shared with V3.5's Organize tab: one
// saved session, whichever app started it). Answers are read by sortSession.ts.

export async function fetchSession(): Promise<unknown> {
  return unwrap(await api.GET('/api/sort/current'))
}

export async function sendAction(req: { action: string; folder_key?: SlotKey }): Promise<unknown> {
  return unwrap(await api.POST('/api/sort/action', { params: { query: req } }))
}

export async function startSession(body: ReturnType<typeof startBody>): Promise<unknown> {
  return unwrap(await api.POST('/api/sort/start', { body }))
}

/** Point the keys at other folders mid-session (the backend creates missing folders). */
export async function setFolders(folders: SlotMap<string>, collections: SlotMap<number>): Promise<unknown> {
  return unwrap(
    await api.POST('/api/sort/set-folders', {
      body: { folders: folders as Record<string, string>, collection_slots: collections as Record<string, number> },
    }),
  )
}

export async function clearSession(): Promise<void> {
  unwrap(await api.DELETE('/api/sort/session'))
}
