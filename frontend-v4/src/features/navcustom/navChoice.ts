// Which places the top bar shows and in what order (Customize places…). Pure:
// both interfaces (V Opus and /next/) use it with their own place lists and
// their own storage key. A choice is the order of EVERY place plus the ones
// hidden; a hidden place keeps its slot so showing it again puts it back where
// the user left it.

export interface NavDef {
  id: string
  /** Shown in the bar until the user hides it (default true). */
  shown?: boolean
  /** Hidden, it waits in the Tools menu instead of under More (a tool). */
  inTools?: boolean
}

export interface NavChoice {
  order: string[]
  hidden: string[]
}

export function defaultChoice(defs: readonly NavDef[]): NavChoice {
  return { order: defs.map((d) => d.id), hidden: defs.filter((d) => d.shown === false).map((d) => d.id) }
}

/**
 * Make any stored value a valid choice for `defs`: unknown places dropped,
 * places added since it was saved appended (shown or hidden as their default
 * says), repeats dropped, and at least one place left in the bar.
 */
export function normalizeChoice(value: unknown, defs: readonly NavDef[]): NavChoice {
  const base = defaultChoice(defs)
  const known = new Set(base.order)
  const raw = (value && typeof value === 'object' ? value : {}) as { order?: unknown; hidden?: unknown }
  const ids = (list: unknown): string[] => (Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && known.has(x)) : [])
  const order = [...new Set(ids(raw.order))]
  const hidden = new Set(ids(raw.hidden))
  const saved = new Set(order)
  for (const id of base.order) {
    if (saved.has(id)) continue
    order.push(id)
    if (base.hidden.includes(id)) hidden.add(id)
  }
  if (order.every((id) => hidden.has(id))) hidden.delete(order[0]!)
  return { order, hidden: order.filter((id) => hidden.has(id)) }
}

export function parseChoice(raw: string | null, defs: readonly NavDef[]): NavChoice {
  try {
    return normalizeChoice(raw ? JSON.parse(raw) : null, defs)
  } catch {
    return defaultChoice(defs)
  }
}

export function shownIds(choice: NavChoice): string[] {
  return choice.order.filter((id) => !choice.hidden.includes(id))
}

export function hiddenIds(choice: NavChoice): string[] {
  return choice.order.filter((id) => choice.hidden.includes(id))
}

export function isDefaultChoice(choice: NavChoice, defs: readonly NavDef[]): boolean {
  const base = defaultChoice(defs)
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
  return same(choice.order, base.order) && same(choice.hidden, base.hidden)
}

export interface ToggleResult {
  choice: NavChoice
  /** true: this was the last place in the bar, so it stayed. */
  refused: boolean
}

/** Show or hide one place. The last place in the bar cannot be hidden (refused). */
export function setShown(choice: NavChoice, id: string, shown: boolean): ToggleResult {
  if (!choice.order.includes(id)) return { choice, refused: false }
  if (shown) return { choice: { order: choice.order, hidden: choice.hidden.filter((h) => h !== id) }, refused: false }
  if (choice.hidden.includes(id)) return { choice, refused: false }
  if (shownIds(choice).length <= 1) return { choice, refused: true }
  return { choice: { order: choice.order, hidden: [...choice.hidden, id] }, refused: false }
}

/** Put `id` at position `to` (0-based, among all places); out of range is clamped. */
export function moveTo(choice: NavChoice, id: string, to: number): NavChoice {
  const from = choice.order.indexOf(id)
  if (from === -1) return choice
  const target = Math.max(0, Math.min(choice.order.length - 1, to))
  if (target === from) return choice
  const order = choice.order.filter((x) => x !== id)
  order.splice(target, 0, id)
  return { order, hidden: choice.hidden }
}

/** Move one place up (-1) or down (+1). */
export function moveBy(choice: NavChoice, id: string, step: -1 | 1): NavChoice {
  return moveTo(choice, id, choice.order.indexOf(id) + step)
}
