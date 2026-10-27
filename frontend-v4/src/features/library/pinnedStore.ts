// What the library remembers per library about a set of pictures shown from
// the Style Map (pinnedSet.ts): the hidden set's id and how many pictures it
// had. Pure, so it can be tested without a browser.

export interface StoredPin {
  /** The hidden set's collection id. */
  id: number
  count: number
}

/** The remembered sets by library id; anything damaged or of the wrong shape is dropped. */
export function parsePins(text: string | null): Record<string, StoredPin> {
  let raw: unknown = null
  try {
    raw = text ? JSON.parse(text) : null
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, StoredPin> = {}
  for (const [libraryId, value] of Object.entries(raw as Record<string, unknown>)) {
    const pin = value as Partial<StoredPin> | null
    const id = Number(pin?.id)
    const count = Number(pin?.count)
    if (libraryId && Number.isInteger(id) && id > 0) out[libraryId] = { id, count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0 }
  }
  return out
}

/** The memory with one library's set replaced (null forgets it); the other libraries' stay. */
export function withPin(pins: Record<string, StoredPin>, libraryId: string, pin: StoredPin | null): Record<string, StoredPin> {
  const next = { ...pins }
  if (pin) next[libraryId] = { id: pin.id, count: pin.count }
  else delete next[libraryId]
  return next
}
