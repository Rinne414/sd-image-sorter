// Pure rules of the Pick step's own selection (which images a removal
// applies to). Keys are entry keys in the batch's order. Every function
// returns new data and leaves its input alone.

export interface PickSelection {
  keys: ReadonlySet<string>
  /** Where a Shift click starts from. */
  anchor: number | null
}

export const NO_PICKS: PickSelection = { keys: new Set(), anchor: null }

/**
 * After a click on the image at `index`: a plain click only moves the cursor
 * (and drops the selection), Ctrl toggles that image, Shift selects the run
 * from the last clicked image to this one.
 */
export function clickSelection(
  sel: PickSelection,
  order: readonly string[],
  index: number,
  mods: { ctrl: boolean; shift: boolean },
): PickSelection {
  const key = order[index]
  if (key === undefined) return sel
  if (mods.shift) {
    const from = sel.anchor ?? index
    const [lo, hi] = from <= index ? [from, index] : [index, from]
    return { keys: new Set(order.slice(lo, hi + 1)), anchor: from }
  }
  if (mods.ctrl) {
    const keys = new Set(sel.keys)
    if (keys.has(key)) keys.delete(key)
    else keys.add(key)
    return { keys, anchor: index }
  }
  return { keys: new Set(), anchor: index }
}

export function selectAll(order: readonly string[]): PickSelection {
  return { keys: new Set(order), anchor: order.length > 0 ? 0 : null }
}

/** The selection without images that left the batch. */
export function keepPresent(sel: PickSelection, order: readonly string[]): PickSelection {
  const present = new Set(order)
  const keys = [...sel.keys].filter((key) => present.has(key))
  return keys.length === sel.keys.size ? sel : { keys: new Set(keys), anchor: sel.anchor }
}

/** What Delete takes out: the selected images in batch order, else the one under the cursor. */
export function removalKeys(sel: PickSelection, order: readonly string[], cursor: number): string[] {
  if (sel.keys.size > 0) return order.filter((key) => sel.keys.has(key))
  const key = order[cursor]
  return key === undefined ? [] : [key]
}
