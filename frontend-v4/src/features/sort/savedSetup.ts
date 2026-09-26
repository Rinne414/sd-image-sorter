import { cleanRule, EMPTY_RULE, type RuleSetup } from './rules'
import { SLOT_KEYS, type FileOperation, type SlotKey, type SlotMap, type SortMode } from './sortSession'

// What a new sort starts with: the way to sort, the folder behind each key
// and move or copy. Remembered per library in this browser, so the next sort
// of the same library needs no setting up at all; named presets (sortPrefs.ts)
// store the same shape.

/** The ways to sort the setup offers: the three sessions, and sort by condition (a background run). */
export type SetupMode = SortMode | 'rules'
export const SETUP_MODES: readonly SetupMode[] = ['slot', 'bracket', 'cull', 'rules']

export interface SortSetup {
  mode: SetupMode
  folders: SlotMap<string>
  operation: FileOperation
  /** Sort by condition: what matches, where it goes, how it splits. */
  rule: RuleSetup
}

export const EMPTY_SETUP: SortSetup = { mode: 'slot', folders: {}, operation: 'move', rule: EMPTY_RULE }

const keyOf = (libraryId: string) => `sd-v4-sort-setup:${libraryId}`

/** A stored setup made safe: unknown keys, empty paths and junk values dropped. */
export function cleanSetup(raw: unknown): SortSetup {
  if (!raw || typeof raw !== 'object') return EMPTY_SETUP
  const { mode, folders, operation, rule } = raw as { mode?: unknown; folders?: unknown; operation?: unknown; rule?: unknown }
  const clean: SlotMap<string> = {}
  for (const k of SLOT_KEYS) {
    const path = (folders as Record<string, unknown> | undefined)?.[k]
    if (typeof path === 'string' && path.trim()) clean[k] = path
  }
  return {
    mode: SETUP_MODES.includes(mode as SetupMode) ? (mode as SetupMode) : 'slot',
    folders: clean,
    operation: operation === 'copy' ? 'copy' : 'move',
    rule: cleanRule(rule),
  }
}

/** The setup last used in this library (empty when none, or when storage is blocked or junk). */
export function loadSetup(libraryId: string): SortSetup {
  try {
    return cleanSetup(JSON.parse(localStorage.getItem(keyOf(libraryId)) ?? 'null'))
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

/** Fewest images each way to sort needs: A/B compares two at least. */
export const MIN_IMAGES: Record<SetupMode, number> = { slot: 1, bracket: 2, cull: 1, rules: 1 }

/** Whether the setup can start at all (keys to folders need a folder, sort by condition its destination). */
export function setupReady(setup: SortSetup): boolean {
  if (setup.mode === 'slot') return hasFolder(setup)
  return setup.mode !== 'rules' || !!setup.rule.destination
}

/** Body of POST /api/sort/start for these images. A/B and keep/reject never touch files. */
export function startBody(ids: number[], setup: SortSetup, replace: boolean) {
  // Sort by condition never starts a session; a setup in that mode starts none.
  const mode: SortMode = setup.mode === 'rules' ? 'slot' : setup.mode
  const slot = mode === 'slot'
  return {
    image_ids: ids,
    folders: slot ? (Object.fromEntries(SLOT_KEYS.flatMap((k) => (setup.folders[k] ? [[k, setup.folders[k]]] : []))) as Record<string, string>) : {},
    operation_mode: slot ? setup.operation : 'copy',
    replace_existing: replace,
    mode,
    // Filter settings the request model requires; unused when image_ids is given.
    tag_mode: 'and',
    prompt_match_mode: 'exact',
  }
}
