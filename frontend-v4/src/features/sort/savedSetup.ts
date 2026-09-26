import { SLOT_KEYS, type FileOperation, type SlotKey, type SlotMap } from './sortSession'

// What a new sort starts with: the folder behind each key and move or copy.
// Remembered per library in this browser, so the next sort of the same
// library needs no setting up at all.

export interface SortSetup {
  folders: SlotMap<string>
  operation: FileOperation
}

export const EMPTY_SETUP: SortSetup = { folders: {}, operation: 'move' }

const keyOf = (libraryId: string) => `sd-v4-sort-setup:${libraryId}`

/** The setup last used in this library (empty when none, or when storage is blocked or junk). */
export function loadSetup(libraryId: string): SortSetup {
  try {
    const raw = JSON.parse(localStorage.getItem(keyOf(libraryId)) ?? 'null') as unknown
    if (!raw || typeof raw !== 'object') return EMPTY_SETUP
    const { folders, operation } = raw as { folders?: unknown; operation?: unknown }
    const clean: SlotMap<string> = {}
    for (const k of SLOT_KEYS) {
      const path = (folders as Record<string, unknown> | undefined)?.[k]
      if (typeof path === 'string' && path.trim()) clean[k] = path
    }
    return { folders: clean, operation: operation === 'copy' ? 'copy' : 'move' }
  } catch {
    return EMPTY_SETUP
  }
}

export function saveSetup(libraryId: string, setup: SortSetup): void {
  try {
    localStorage.setItem(keyOf(libraryId), JSON.stringify(setup))
  } catch {
    // storage blocked: the setup just won't be remembered
  }
}

/** The setup with one key's folder set (or cleared with null). */
export function withFolder(setup: SortSetup, slot: SlotKey, path: string | null): SortSetup {
  const folders = { ...setup.folders }
  if (path) folders[slot] = path
  else delete folders[slot]
  return { ...setup, folders }
}

export const hasFolder = (setup: SortSetup): boolean => SLOT_KEYS.some((k) => !!setup.folders[k])

/** Body of POST /api/sort/start for these images. */
export function startBody(ids: number[], setup: SortSetup, replace: boolean) {
  return {
    image_ids: ids,
    folders: Object.fromEntries(SLOT_KEYS.flatMap((k) => (setup.folders[k] ? [[k, setup.folders[k]]] : []))) as Record<string, string>,
    operation_mode: setup.operation,
    replace_existing: replace,
    mode: 'slot',
    // Filter settings the request model requires; unused when image_ids is given.
    tag_mode: 'and',
    prompt_match_mode: 'exact',
  }
}
