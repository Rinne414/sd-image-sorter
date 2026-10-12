// The Order step's undo: the orders before each reorder, newest last. V3.5's
// queue kept 50 steps and had no redo; this keeps the same.

export const HISTORY_DEPTH = 50

export type OrderHistory = readonly (readonly string[])[]

export const NO_HISTORY: OrderHistory = []

/** The history with `order` (the order before a reorder) added, the oldest dropped past 50. */
export function pushOrder(history: OrderHistory, order: readonly string[]): OrderHistory {
  return [...history, order].slice(-HISTORY_DEPTH)
}

/** The order to go back to and the history left after it; null when there is nothing to undo. */
export function undoOrder(history: OrderHistory): { order: readonly string[]; history: OrderHistory } | null {
  const order = history[history.length - 1]
  return order ? { order, history: history.slice(0, -1) } : null
}
