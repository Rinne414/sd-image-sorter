import type { Op } from './ops'

// Undo / redo for one image: stacks of earlier and later op lists. Lists are
// small JSON (no pixels), so history is not capped.

export interface History {
  readonly past: readonly Op[][]
  readonly future: readonly Op[][]
}

export const EMPTY_HISTORY: History = { past: [], future: [] }

/** `before` was replaced by a new list: remember it, forget anything that was undone. */
export function record(history: History, before: Op[]): History {
  return { past: [...history.past, before], future: [] }
}

export function undo(history: History, current: Op[]): { history: History; ops: Op[] } | null {
  const ops = history.past.at(-1)
  if (!ops) return null
  return { ops, history: { past: history.past.slice(0, -1), future: [...history.future, current] } }
}

export function redo(history: History, current: Op[]): { history: History; ops: Op[] } | null {
  const ops = history.future.at(-1)
  if (!ops) return null
  return { ops, history: { past: [...history.past, current], future: history.future.slice(0, -1) } }
}
