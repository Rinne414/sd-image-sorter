import { dropGroup, moveInView, type GroupMove } from './orderLogic'
import { useStepViews } from './stepView'
import type { BatchEntries } from './useBatchEntries'

/** The keys a move carries: the selection, else the image under the cursor. */
export function movingKeys(selected: ReadonlySet<string>, cursorKey: string | undefined): ReadonlySet<string> {
  if (selected.size > 0) return selected
  return new Set(cursorKey === undefined ? [] : [cursorKey])
}

/** The keys a drag carries: the selection when the dragged image is in it, else that image alone. */
export function draggedKeys(selected: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return selected.has(key) ? selected : new Set([key])
}

/**
 * Reordering a batch from the Pick or Order step. Each change saves the new
 * order on the server and remembers the one before it, so Ctrl+Z in the Order
 * step can save that one back. Each call returns the new order, or null when
 * nothing moved.
 */
export function orderMoves(source: BatchEntries, key: string) {
  const order = source.entries.map((entry) => entry.key)
  const commit = (next: readonly string[]): readonly string[] | null => {
    if (next === order) return null
    useStepViews.getState().record(key, order)
    source.reorder(next)
    return next
  }
  return {
    move: (keys: ReadonlySet<string>, shown: ReadonlySet<string> | null, how: GroupMove) => commit(moveInView(order, keys, shown, how)),
    drop: (keys: ReadonlySet<string>, overKey: string, after: boolean) => commit(dropGroup(order, keys, order.indexOf(overKey), after)),
    undo: (): readonly string[] | null => {
      const before = useStepViews.getState().takeUndo(key)
      if (before) source.reorder(before)
      return before
    },
  }
}
