// Pure rules of the Order step: moving one image to a new place by drag or by
// key. Every function returns new data and leaves its input alone.

/** The list with the entry at `from` moved to `to` (clamped). The same list when nothing moves. */
export function moveTo<T>(list: readonly T[], from: number, to: number): readonly T[] {
  if (from < 0 || from >= list.length) return list
  const target = Math.max(0, Math.min(list.length - 1, to))
  if (target === from) return list
  const next = list.filter((_, i) => i !== from)
  next.splice(target, 0, list[from] as T)
  return next
}

/**
 * Where Alt + a key moves the image at `index` of `count`: ← or ↑ one place
 * earlier, → or ↓ one place later, Home to the front, End to the back.
 * null when the key does not reorder.
 */
export function reorderTarget(key: string, index: number, count: number): number | null {
  if (index < 0 || index >= count) return null
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return Math.max(0, index - 1)
    case 'ArrowRight':
    case 'ArrowDown':
      return Math.min(count - 1, index + 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/**
 * Items in the order of `ids`, numbered again from 0. Items the list does not
 * name (added meanwhile) keep their relative order at the end.
 */
export function applyOrder<T extends { image_id: number; position: number }>(items: readonly T[], ids: readonly number[]): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]))
  const known = items.filter((item) => rank.has(item.image_id)).sort((a, b) => (rank.get(a.image_id) ?? 0) - (rank.get(b.image_id) ?? 0))
  const rest = items.filter((item) => !rank.has(item.image_id))
  return [...known, ...rest].map((item, position) => (item.position === position ? item : { ...item, position }))
}

/**
 * The final place of an image dragged from `from` and dropped on the image at
 * `over`: before it, or after it when dropped on its right half.
 */
export function dropIndex(from: number, over: number, after: boolean): number {
  const before = after ? over + 1 : over
  return from < before ? before - 1 : before
}
