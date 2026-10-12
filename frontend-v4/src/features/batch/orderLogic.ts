// Pure rules of reordering a batch: moving the selected images together by
// key, button or drag (V3.5's queue rules). Every function returns new data
// and leaves its input alone; "the same list" means nothing moved.

export type GroupMove = 'top' | 'up' | 'down' | 'bottom'

/** What Alt + a key does: ← or ↑ one place earlier, → or ↓ one place later, Home to the front, End to the back. */
export function groupMove(key: string): GroupMove | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return 'up'
    case 'ArrowRight':
    case 'ArrowDown':
      return 'down'
    case 'Home':
      return 'top'
    case 'End':
      return 'bottom'
    default:
      return null
  }
}

function sameOrder<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** Each selected entry swaps with the unselected one before it (working from the front), or after it (from the back). */
function stepGroup<T>(list: readonly T[], selected: ReadonlySet<T>, forward: boolean): T[] {
  const next = [...list]
  const last = next.length - 1
  for (let n = 1; n <= last; n++) {
    const i = forward ? last - n : n
    const j = forward ? i + 1 : i - 1
    if (selected.has(next[i] as T) && !selected.has(next[j] as T)) [next[i], next[j]] = [next[j] as T, next[i] as T]
  }
  return next
}

/**
 * The list with the selected entries moved together: to the top or bottom in
 * their own order, or one place up or down each, past their unselected
 * neighbour (an entry already at the edge stays, the others still move).
 */
export function moveGroup<T>(list: readonly T[], selected: ReadonlySet<T>, how: GroupMove): readonly T[] {
  const picked = list.filter((x) => selected.has(x))
  const rest = list.filter((x) => !selected.has(x))
  let next: readonly T[]
  if (how === 'top') next = [...picked, ...rest]
  else if (how === 'bottom') next = [...rest, ...picked]
  else next = stepGroup(list, selected, how === 'down')
  return sameOrder(next, list) ? list : next
}

/**
 * A group move while a filter shows only `shown` (null: everything). Top and
 * bottom mean the whole batch. Up and down step past the nearest shown image,
 * so the move is visible; hidden entries keep their exact places.
 */
export function moveInView<T>(list: readonly T[], selected: ReadonlySet<T>, shown: ReadonlySet<T> | null, how: GroupMove): readonly T[] {
  if (!shown || how === 'top' || how === 'bottom') return moveGroup(list, selected, how)
  const view = list.filter((x) => shown.has(x))
  const moved = moveGroup(view, selected, how)
  if (moved === view) return list
  let slot = 0
  return list.map((x) => (shown.has(x) ? (moved[slot++] as T) : x))
}

/**
 * The list with the selected entries dropped together before the entry at
 * `over`, or after it. The same list when dropped on one of their own.
 */
export function dropGroup<T>(list: readonly T[], selected: ReadonlySet<T>, over: number, after: boolean): readonly T[] {
  const target = list[over]
  if (target === undefined || selected.has(target)) return list
  const rest = list.filter((x) => !selected.has(x))
  const at = rest.indexOf(target) + (after ? 1 : 0)
  const next = [...rest.slice(0, at), ...list.filter((x) => selected.has(x)), ...rest.slice(at)]
  return sameOrder(next, list) ? list : next
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
