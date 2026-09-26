import { useEffect } from 'react'
import { create } from 'zustand'
import { ApiError } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { useApp } from '../../state/store'
import { clearSession, fetchSession, sendAction, setFolders, startSession } from './sortApi'
import {
  answered,
  failed,
  INITIAL_STATE,
  isOpen,
  press as pressKey,
  readSession,
  requestFor,
  takeNext,
  unfinished,
  type SessionView,
  type SlotKey,
  type SortAction,
  type SortState,
} from './sortSession'
import { startBody, type SortSetup } from './savedSetup'

// The Sort tab's live state: the saved session (from the backend), the keys
// waiting to be sent, and whether the page shows the setup or the session.

/** Where a new sort's images come from: the picks handed over, or everything the library's filter matches. */
export type SortSource = { kind: 'picks'; ids: number[] } | { kind: 'filter' }

export type StartResult = 'ok' | 'conflict' | { error: string }

interface SortStore extends SortState {
  /** The setup is showing (a new sort), not the saved session. */
  setupOpen: boolean
  /** Images handed over by "Sort these…" or "Sort every match"; null: the setup offers what the library has. */
  source: SortSource | null
  load: () => Promise<void>
  press: (action: SortAction) => void
  start: (ids: number[], setup: SortSetup, replace: boolean) => Promise<StartResult>
  end: () => Promise<boolean>
  openSetup: (source: SortSource | null) => void
  resume: () => void
  setSlotFolder: (slot: SlotKey, path: string) => Promise<boolean>
}

// What moving files changes in the library (copies are not indexed).
const MOVED_KEYS = ['images', 'image', 'folders', 'image-count', 'library-health', 'missing-summary']

function refreshLibrary(action: SortAction, moved: boolean): void {
  if (action.kind === 'skip' || !moved) return
  for (const key of MOVED_KEYS) void queryClient.invalidateQueries({ queryKey: [key] })
}

export const useSort = create<SortStore>((set, get) => {
  /** Send queued keys one at a time, in order. */
  const pump = async (): Promise<void> => {
    const state = get()
    const next = takeNext(state)
    if (!next || !isOpen(state.session)) return
    const view = state.session
    set(next.state)
    try {
      const payload = await sendAction(requestFor(view, next.action))
      set((cur) => answered(cur, next.action, payload))
      refreshLibrary(next.action, view.operation === 'move')
    } catch (error) {
      set((cur) => failed(cur, (error as Error).message))
    }
    void pump()
  }

  return {
    ...INITIAL_STATE,
    setupOpen: false,
    source: null,

    load: async () => {
      try {
        const session = readSession(await fetchSession())
        set({ session, queue: [], sending: false, error: null })
      } catch (error) {
        set({ session: 'none', error: { kind: 'failed', reason: (error as Error).message } })
      }
    },

    press: (action) => {
      set((cur) => pressKey(cur, action))
      void pump()
    },

    start: async (ids, setup, replace) => {
      try {
        await startSession(startBody(ids, setup, replace))
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) return 'conflict'
        return { error: (error as Error).message }
      }
      set({ ...INITIAL_STATE, setupOpen: false, source: null })
      await get().load()
      return 'ok'
    },

    end: async () => {
      try {
        await clearSession()
      } catch (error) {
        set({ error: { kind: 'failed', reason: (error as Error).message } })
        return false
      }
      set({ ...INITIAL_STATE, session: 'none', setupOpen: true })
      return true
    },

    openSetup: (source) => set({ setupOpen: true, source, error: null }),
    resume: () => set({ setupOpen: false, source: null, error: null }),

    setSlotFolder: async (slot, path) => {
      const view = get().session
      if (!isOpen(view)) return false
      try {
        await setFolders({ ...view.folders, [slot]: path }, view.collections)
      } catch (error) {
        set({ error: { kind: 'failed', reason: (error as Error).message } })
        return false
      }
      await get().load()
      return true
    },
  }
})

/** Hand images to the Sort tab and go there ("Sort these…", "Sort every match"). */
export function sortImages(source: SortSource): void {
  useSort.getState().openSetup(source)
  useApp.getState().setPage('sort')
}

/** The Sort tab's setup for a new sort of whatever the library has picked or filtered. */
export function newSort(): void {
  useSort.getState().openSetup(null)
  useApp.getState().setPage('sort')
}

/** Back into the unfinished sort on the Sort tab. */
export function continueSort(): void {
  useSort.getState().resume()
  useApp.getState().setPage('sort')
}

/**
 * The unfinished WASD sort, for "Continue" on Home and in Ctrl K. Asks the
 * backend on mount when `refresh` (V3.5 may have moved on) or when nothing is known yet.
 */
export function useSortPending(refresh = false): SessionView | null {
  const session = useSort((s) => s.session)
  useEffect(() => {
    const s = useSort.getState()
    if (refresh || s.session === null) void s.load()
  }, [refresh])
  const view = unfinished(session)
  return view && view.mode === 'slot' ? view : null
}
