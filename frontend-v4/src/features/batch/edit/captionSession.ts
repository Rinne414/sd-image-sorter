import { createStore } from 'zustand/vanilla'
import type { Author, CaptionContent } from '../datasetTag'
import { sameContent } from './captionContent'

// The caption editor's working state for one batch. Every change is saved as
// a revision after a short pause (no drafts kept anywhere else); a save names
// the head generation it was made on, so an edit made meanwhile elsewhere (V3.5,
// an AI run) is never overwritten: the image is read again and the user is
// told, with their own version one click away. Undo walks back through what
// this session saved. The API calls are passed in, so this runs in tests.

/** What the server holds for one image. */
export interface HeadSnapshot {
  generation: number
  revisionId: number | null
  subjectId: number | null
  author: Author | null
  content: CaptionContent | null
}

export const NO_HEAD: HeadSnapshot = { generation: 0, revisionId: null, subjectId: null, author: null, content: null }

export type SaveOutcome =
  | { kind: 'saved'; head: HeadSnapshot }
  /** The caption changed elsewhere: `head` is what the server holds now. */
  | { kind: 'conflict'; head: HeadSnapshot }
  | { kind: 'failed'; reason: string }

export interface SessionDeps {
  save: (key: string, content: CaptionContent, generation: number) => Promise<SaveOutcome>
  restore: (key: string, revisionId: number, subjectId: number, generation: number) => Promise<SaveOutcome>
  /** Quiet time after the last change before it is saved. */
  delayMs: number
}

export type ItemStatus = 'saved' | 'waiting' | 'saving' | 'failed' | 'conflict'

export interface ItemState {
  head: HeadSnapshot
  /** What the editor shows. */
  content: CaptionContent
  status: ItemStatus
  /** Earlier contents, newest last. */
  undo: CaptionContent[]
  /** The user's version a conflict replaced (they can put it back). */
  lost: CaptionContent | null
  error: string | null
}

export interface SessionState {
  items: Record<string, ItemState>
}

export type CaptionSession = ReturnType<typeof createCaptionSession>

export function createCaptionSession(deps: SessionDeps) {
  const store = createStore<SessionState>(() => ({ items: {} }))
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inFlight = new Set<string>()

  const get = (key: string): ItemState | undefined => store.getState().items[key]
  const put = (key: string, patch: Partial<ItemState>) => {
    const old = get(key)
    if (!old) return
    store.setState((s) => ({ items: { ...s.items, [key]: { ...old, ...patch } } }))
  }
  const stopTimer = (key: string) => {
    const timer = timers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(key)
  }
  const schedule = (key: string, ms = deps.delayMs) => {
    stopTimer(key)
    timers.set(key, setTimeout(() => void flush(key), ms))
  }

  /** The server says the caption changed elsewhere: show its version, keep the user's to put back. */
  function conflict(key: string, head: HeadSnapshot, mine: CaptionContent): void {
    stopTimer(key)
    const item = get(key)
    if (!item) return
    put(key, { head, content: head.content ?? item.content, status: 'conflict', undo: [], lost: mine, error: null })
  }

  function settle(key: string, sent: CaptionContent, outcome: SaveOutcome): void {
    const item = get(key)
    if (!item) return
    if (outcome.kind === 'conflict') return conflict(key, outcome.head, item.content)
    if (outcome.kind === 'failed') {
      stopTimer(key)
      return put(key, { status: 'failed', error: outcome.reason })
    }
    // Changes made while it was saving are saved next.
    const moved = !sameContent(item.content, sent)
    put(key, { head: outcome.head, status: moved ? 'waiting' : 'saved', error: null })
    if (moved) schedule(key)
  }

  async function flush(key: string): Promise<void> {
    stopTimer(key)
    const item = get(key)
    if (!item || item.status !== 'waiting' || inFlight.has(key)) return
    const sent = item.content
    inFlight.add(key)
    put(key, { status: 'saving' })
    try {
      settle(key, sent, await deps.save(key, sent, item.head.generation))
    } catch (error) {
      settle(key, sent, { kind: 'failed', reason: (error as Error).message })
    } finally {
      inFlight.delete(key)
    }
  }

  function edit(key: string, change: (content: CaptionContent) => CaptionContent): void {
    const item = get(key)
    if (!item) return
    const next = change(item.content)
    if (sameContent(next, item.content)) return
    // A change after a pause starts a new undo step.
    const undo = item.status === 'waiting' ? item.undo : [...item.undo, item.content]
    put(key, { content: next, status: 'waiting', undo, error: null })
    schedule(key)
  }

  return {
    store,

    /** Show an image: what the server holds, or `initial` when it was never edited. Kept work stays. */
    open(key: string, head: HeadSnapshot, initial: CaptionContent): void {
      const item = get(key)
      const fresh: ItemState = { head, content: head.content ?? initial, status: 'saved', undo: [], lost: null, error: null }
      if (!item) {
        store.setState((s) => ({ items: { ...s.items, [key]: fresh } }))
        return
      }
      // Saved elsewhere since (an AI run): take the newer version unless the user is mid-edit.
      if (head.generation > item.head.generation && item.status === 'saved') put(key, { ...fresh, undo: item.undo })
    },

    edit,

    /** Save now what is waiting (moving to another image, leaving the step). */
    flush,

    flushAll(): Promise<void[]> {
      return Promise.all(Object.keys(store.getState().items).map((key) => flush(key)))
    },

    /** Back to the version before the last change; saved as a new revision. */
    undo(key: string): void {
      const item = get(key)
      const previous = item?.undo.at(-1)
      if (!item || !previous) return
      put(key, { content: previous, undo: item.undo.slice(0, -1), status: 'waiting', error: null })
      void flush(key)
    },

    /** Try a failed save again. */
    retry(key: string): void {
      if (get(key)?.status !== 'failed') return
      put(key, { status: 'waiting' })
      void flush(key)
    },

    /** After a conflict: put the user's version back on top of the newer one (a new revision). */
    reapplyLost(key: string): void {
      const lost = get(key)?.lost
      if (!lost) return
      put(key, { lost: null })
      edit(key, () => lost)
    },

    dismiss(key: string): void {
      const item = get(key)
      if (item?.status === 'conflict') put(key, { status: 'saved', lost: null })
    },

    /** Make an earlier revision the current one (a new revision; the one it replaces stays in the history). */
    async restore(key: string, revisionId: number): Promise<boolean> {
      stopTimer(key)
      const item = get(key)
      if (!item || item.head.subjectId === null || inFlight.has(key)) return false
      inFlight.add(key)
      put(key, { status: 'saving' })
      try {
        const outcome = await deps.restore(key, revisionId, item.head.subjectId, item.head.generation)
        if (outcome.kind === 'saved') {
          const undo = [...item.undo, item.content]
          put(key, { head: outcome.head, content: outcome.head.content ?? item.content, status: 'saved', undo, error: null })
          return true
        }
        settle(key, item.content, outcome)
        return false
      } finally {
        inFlight.delete(key)
      }
    },

    dispose(): void {
      for (const key of [...timers.keys()]) stopTimer(key)
    },
  }
}
