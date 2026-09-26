import { useEffect } from 'react'
import { useStore } from 'zustand'
import { tr } from '../../jobs/jobs'
import type { Entry } from '../entries'
import { restoreCaption, saveCaption } from './captionApi'
import { createCaptionSession, type CaptionSession, type ItemState } from './captionSession'

/** Quiet time after the last change before it is saved as a revision. */
const SAVE_AFTER_MS = 600

interface Holder {
  session: CaptionSession
  /** The batch's images by key, as last shown (a save needs the image's identity). */
  entries: Map<string, Entry>
  /** The image the editor showed last, to come back to. */
  current: string | null
  /** One caption at a time, or many at once (the step comes back the way it was left). */
  mode: 'one' | 'bulk'
  /** Images another step asked to have picked for a bulk change (taken once, when the step opens). */
  picked: string[] | null
}

// One session per batch for the whole app visit: a save still waiting when
// the user leaves the step (or the batch) is sent, not dropped.
const holders = new Map<number, Holder>()

function gone(): Promise<{ kind: 'failed'; reason: string }> {
  return Promise.resolve({ kind: 'failed', reason: tr('dataset.edit.notInProject') })
}

export function captionHolder(batchId: number): Holder {
  const known = holders.get(batchId)
  if (known) return known
  const entries = new Map<string, Entry>()
  const session = createCaptionSession({
    delayMs: SAVE_AFTER_MS,
    save: (key, content, generation) => {
      const entry = entries.get(key)
      return entry ? saveCaption(batchId, entry, content, generation) : gone()
    },
    restore: (key, revisionId, subjectId, generation) => {
      const entry = entries.get(key)
      return entry ? restoreCaption(batchId, entry, revisionId, subjectId, generation) : gone()
    },
  })
  const holder: Holder = { session, entries, current: null, mode: 'one', picked: null }
  holders.set(batchId, holder)
  return holder
}

/** The batch's caption session; the images it may save are kept current, and leaving saves at once. */
export function useCaptionSession(batchId: number, entries: readonly Entry[]): CaptionSession {
  const holder = captionHolder(batchId)
  useEffect(() => {
    holder.entries.clear()
    for (const entry of entries) holder.entries.set(entry.key, entry)
  }, [holder, entries])
  useEffect(() => () => void holder.session.flushAll(), [holder])
  return holder.session
}

export function useItemState(session: CaptionSession, key: string | null): ItemState | undefined {
  return useStore(session.store, (s) => (key ? s.items[key] : undefined))
}
