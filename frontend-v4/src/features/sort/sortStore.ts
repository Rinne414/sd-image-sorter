import { useEffect } from 'react'
import { create } from 'zustand'
import { ApiError } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { useApp } from '../../state/store'
import { startBody, type SortSetup } from './savedSetup'
import { clearSession, fetchSession, sendAction, setFolders, startSession } from './sortApi'
import { tooSoon } from './sortModes'
import { useSortPrefs } from './sortPrefs'
import {
  answered,
  awaitsLibraryOk,
  crossLibraryKey,
  failed,
  INITIAL_STATE,
  isForward,
  isOpen,
  isRefusal,
  press as pressKey,
  readSession,
  reloaded,
  requestFor,
  takeNext,
  unfinished,
  type SessionView,
  type SlotKey,
  type SortAction,
  type SortState,
} from './sortSession'
import { pip } from './sound'

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
  /** When the last key that counted was pressed (for the cooldown). */
  lastPressAt: number | null
  /** Goes up each time a key is ignored for coming too soon, so the picture can flinch. */
  bumped: number
  /** When recent images were decided (for the pace shown in the header). */
  stamps: number[]
  /** The sort of another library the user said to keep sorting (`crossLibraryKey`); only in memory, so for this sort only. */
  libraryOk: string | null
  load: () => Promise<void>
  press: (action: SortAction) => void
  /** "Keep sorting the other library's images": keys and buttons act on them from now on. */
  allowOtherLibrary: () => void
  start: (ids: number[], setup: SortSetup, replace: boolean) => Promise<StartResult>
  end: () => Promise<boolean>
  openSetup: (source: SortSource | null) => void
  resume: () => void
  setSlotFolder: (slot: SlotKey, path: string) => Promise<boolean>
}

// What moving files changes in the library (copies are not indexed).
const MOVED_KEYS = ['images', 'image', 'folders', 'image-count', 'library-health', 'missing-summary']
/** Decisions kept for the pace (a minute's worth at any speed a person sorts). */
const STAMPS_KEPT = 120

function refreshLibrary(action: SortAction, view: SessionView): void {
  const moves = view.mode === 'slot' && view.operation === 'move'
  if (action.kind === 'skip' || !moves) return
  for (const key of MOVED_KEYS) void queryClient.invalidateQueries({ queryKey: [key] })
}

export const useSort = create<SortStore>((set, get) => {
  /** One action out and its answer in. A/B and keep/reject answer with flags only, so their session is read again. */
  const send = async (view: SessionView, action: SortAction): Promise<void> => {
    const payload = await sendAction(requestFor(view, action))
    if (view.mode === 'slot' || isRefusal(payload)) {
      set((cur) => answered(cur, action, payload))
      return
    }
    const current = await fetchSession()
    set((cur) => reloaded(cur, action, payload, current))
  }

  /** Send queued keys one at a time, in order. */
  const pump = async (): Promise<void> => {
    const state = get()
    const next = takeNext(state)
    if (!next || !isOpen(state.session)) return
    const view = state.session
    set(next.state)
    try {
      await send(view, next.action)
      refreshLibrary(next.action, view)
      const error = get().error
      if (isForward(next.action) && (error === null || error.kind === 'cooldown')) set((cur) => ({ stamps: [...cur.stamps, Date.now()].slice(-STAMPS_KEPT) }))
    } catch (error) {
      set((cur) => failed(cur, (error as Error).message))
    }
    void pump()
  }

  return {
    ...INITIAL_STATE,
    setupOpen: false,
    source: null,
    lastPressAt: null,
    bumped: 0,
    stamps: [],
    libraryOk: null,

    load: async () => {
      try {
        const session = readSession(await fetchSession())
        set({ session, queue: [], sending: false, error: null })
      } catch (error) {
        set({ session: 'none', error: { kind: 'failed', reason: (error as Error).message } })
      }
    },

    press: (action) => {
      const { cooldownMs, sound } = useSortPrefs.getState()
      const now = Date.now()
      const before = get()
      if (isOpen(before.session) && awaitsLibraryOk(before.session, useApp.getState().libraryId, before.libraryOk)) {
        set({ error: { kind: 'otherLibrary' }, bumped: before.bumped + 1 })
        return
      }
      if (isForward(action) && tooSoon(before.lastPressAt, now, cooldownMs)) {
        set({ error: { kind: 'cooldown' }, bumped: before.bumped + 1 })
        return
      }
      const after = pressKey(before, action)
      const accepted = after.queue.length > before.queue.length
      set({ ...after, lastPressAt: accepted && isForward(action) ? now : before.lastPressAt })
      if (accepted && sound && isForward(action) && action.kind !== 'skip') pip()
      void pump()
    },

    allowOtherLibrary: () => {
      const view = get().session
      if (!isOpen(view)) return
      set((cur) => ({ libraryOk: crossLibraryKey(view, useApp.getState().libraryId), error: cur.error?.kind === 'otherLibrary' ? null : cur.error }))
    },

    start: async (ids, setup, replace) => {
      try {
        await startSession(startBody(ids, setup, replace))
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) return 'conflict'
        return { error: (error as Error).message }
      }
      set({ ...INITIAL_STATE, setupOpen: false, source: null, stamps: [], lastPressAt: null, libraryOk: null })
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
      set({ ...INITIAL_STATE, session: 'none', setupOpen: true, stamps: [], libraryOk: null })
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
 * The unfinished sort, for "Continue" on Home and in Ctrl K. Asks the
 * backend on mount when `refresh` (V3.5 may have moved on) or when nothing is known yet.
 */
export function useSortPending(refresh = false): SessionView | null {
  const session = useSort((s) => s.session)
  useEffect(() => {
    const s = useSort.getState()
    if (refresh || s.session === null) void s.load()
  }, [refresh])
  return unfinished(session)
}
