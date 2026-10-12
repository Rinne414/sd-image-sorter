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
  /**
   * Keys that add the image to Favorites instead of moving it (such a key has
   * no folder). The file stays where it is; the key's undo takes it out again.
   */
  favorites: SlotKey[]
  operation: FileOperation
  /** Sort by condition: what matches, where it goes, how it splits. */
  rule: RuleSetup
  /** Sort by condition: further rules, tried in order after the first (ruleSet.ts). */
  more: RuleSetup[]
}

// Copy until the user picks move once (owner, ADR-2026-05-16-copy-default in
// docs/AI_DECISION_LOG.md): a first sort must never move a library by surprise.
export const EMPTY_SETUP: SortSetup = { mode: 'slot', folders: {}, favorites: [], operation: 'copy', rule: EMPTY_RULE, more: [] }

const keyOf = (libraryId: string) => `sd-v4-sort-setup:${libraryId}`

/** Stored Favorites keys: known keys only, each once, in key order. */
const cleanFavorites = (raw: unknown): SlotKey[] => (Array.isArray(raw) ? SLOT_KEYS.filter((k) => raw.includes(k)) : [])

/** A stored setup made safe: unknown keys, empty paths and junk values dropped. */
export function cleanSetup(raw: unknown): SortSetup {
  if (!raw || typeof raw !== 'object') return EMPTY_SETUP
  const { mode, folders, favorites, operation, rule, more } = raw as Record<string, unknown>
  const clean: SlotMap<string> = {}
  for (const k of SLOT_KEYS) {
    const path = (folders as Record<string, unknown> | undefined)?.[k]
    if (typeof path === 'string' && path.trim()) clean[k] = path
  }
  return {
    mode: SETUP_MODES.includes(mode as SetupMode) ? (mode as SetupMode) : 'slot',
    folders: clean,
    favorites: cleanFavorites(favorites),
    operation: operation === 'move' ? 'move' : 'copy',
    rule: cleanRule(rule),
    // A setup or preset from before several rules has none added.
    more: Array.isArray(more) ? more.filter((r) => r && typeof r === 'object').map(cleanRule) : [],
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

/** The setup with one key's folder set (or the key cleared with null); the key no longer adds to Favorites. */
export function withFolder(setup: SortSetup, slot: SlotKey, path: string | null): SortSetup {
  const folders = { ...setup.folders }
  if (path) folders[slot] = path
  else delete folders[slot]
  return { ...setup, folders, favorites: setup.favorites.filter((k) => k !== slot) }
}

/** The setup with one key adding to Favorites (and no longer moving into a folder). */
export function withFavorites(setup: SortSetup, slot: SlotKey): SortSetup {
  const folders = { ...setup.folders }
  delete folders[slot]
  return { ...setup, folders, favorites: SLOT_KEYS.filter((k) => k === slot || setup.favorites.includes(k)) }
}

/** Some key has somewhere to send an image (a folder or Favorites). */
export const hasFolder = (setup: SortSetup): boolean => SLOT_KEYS.some((k) => !!setup.folders[k] || setup.favorites.includes(k))


/** Fewest images each way to sort needs: A/B compares two at least. */
export const MIN_IMAGES: Record<SetupMode, number> = { slot: 1, bracket: 2, cull: 1, rules: 1 }

/** Whether the setup can start at all (keys to folders need a folder, sort by condition its destination). */
export function setupReady(setup: SortSetup): boolean {
  if (setup.mode === 'slot') return hasFolder(setup)
  return setup.mode !== 'rules' || !!setup.rule.destination
}

/**
 * Body of POST /api/sort/start for these images. A/B and keep/reject never
 * touch files. A Favorites key is a collection key on the Favorites
 * collection (`favoritesId`); the backend favorites the image as the heart does.
 */
export function startBody(ids: number[], setup: SortSetup, replace: boolean, favoritesId: number | null = null) {
  // Sort by condition never starts a session; a setup in that mode starts none.
  const mode: SortMode = setup.mode === 'rules' ? 'slot' : setup.mode
  const slot = mode === 'slot'
  return {
    image_ids: ids,
    folders: slot ? (Object.fromEntries(SLOT_KEYS.flatMap((k) => (setup.folders[k] ? [[k, setup.folders[k]]] : []))) as Record<string, string>) : {},
    collection_slots: slot && favoritesId !== null ? Object.fromEntries(setup.favorites.map((k) => [k, favoritesId])) : {},
    operation_mode: slot ? setup.operation : 'copy',
    replace_existing: replace,
    mode,
    // Filter settings the request model requires; unused when image_ids is given.
    tag_mode: 'and',
    prompt_match_mode: 'exact',
  }
}
