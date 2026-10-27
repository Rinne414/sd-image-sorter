import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { api, unwrap } from '../../api/client'
import { useFavorites } from '../../api/queries'
import type { components } from '../../api/schema'
import { parseSearch, toImageParams, type ImageQueryParams, type ScopeFilter } from '../../lib/searchQuery'
import { toSelectionBody } from '../../lib/selectionBody'
import { useApp } from '../../state/store'
import { isEverything } from '../sort/rules'
import { byName, matchKeys, outsideLibrary, shownKeys } from './batchFilter'
import { intersectPages, PAGE, type MatchPage, type MatchPages } from './batchMatch'
import type { Entry } from './entries'
import { favoriteKeys } from './librarySearch'
import { NO_HISTORY, pushOrder, undoOrder, type OrderHistory } from './orderHistory'
import type { Grouping } from './queueSortRun'

// What each batch's steps show and can undo, per library and batch, while the
// app is open: the name filter and condition (shared by Pick, Censor and
// Order, so they carry from step to step; "only favorites" is part of the
// condition) and the reorder history.

interface State {
  names: Readonly<Record<string, string>>
  conditions: Readonly<Record<string, string>>
  favorites: Readonly<Record<string, boolean>>
  histories: Readonly<Record<string, OrderHistory>>
  /** The sort the queue was last put in (the Order step marks where each group starts). */
  groupings: Readonly<Record<string, Grouping>>
  setName: (key: string, text: string) => void
  setCondition: (key: string, text: string) => void
  setFavorites: (key: string, on: boolean) => void
  setGrouping: (key: string, grouping: Grouping | null) => void
  /** Remember the order before a reorder. */
  record: (key: string, order: readonly string[]) => void
  /** The order before the last reorder, taken off the history; null when there is none. */
  takeUndo: (key: string) => readonly string[] | null
}

export const useStepViews = create<State>((set, get) => ({
  names: {},
  conditions: {},
  favorites: {},
  histories: {},
  groupings: {},
  setName: (key, text) => set((s) => ({ names: { ...s.names, [key]: text } })),
  setCondition: (key, text) => set((s) => ({ conditions: { ...s.conditions, [key]: text } })),
  setFavorites: (key, on) => set((s) => ({ favorites: { ...s.favorites, [key]: on } })),
  setGrouping: (key, grouping) =>
    set((s) => {
      const { [key]: _gone, ...rest } = s.groupings
      return { groupings: grouping ? { ...rest, [key]: grouping } : rest }
    }),
  record: (key, order) => set((s) => ({ histories: { ...s.histories, [key]: pushOrder(s.histories[key] ?? NO_HISTORY, order) } })),
  takeUndo: (key) => {
    const undo = undoOrder(get().histories[key] ?? NO_HISTORY)
    if (!undo) return null
    set((s) => ({ histories: { ...s.histories, [key]: undo.history } }))
    return undo.order
  },
}))

export const viewKey = (libraryId: string, batchId: number) => `${libraryId}:${batchId}`

/** This batch's key in the view store, for the library shown now. */
export function useViewKey(batchId: number): string {
  return viewKey(useApp((s) => s.libraryId), batchId)
}

const WHOLE_LIBRARY: ScopeFilter = { generators: [], folder: null, favoritesCollectionId: null }
const SETTLE_MS = 300

/** `value` once it has stopped changing for a moment (a search per pause, not per key). */
function useSettled(value: string): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [value])
  return settled
}

type TokenBody = components['schemas']['SelectionTokenRequest']

/** The library's matches for these gallery filters, page by page (POST selection-token, GET selection-chunk). */
function serverPages(params: ImageQueryParams, signal: AbortSignal): MatchPages {
  return {
    token: async () => {
      const body = { ...toSelectionBody(params), chunkSize: PAGE } as unknown as TokenBody
      return unwrap<{ selection_token: string }>(await api.POST('/api/images/selection-token', { body, signal })).selection_token
    },
    chunk: async (token, offset, limit) =>
      unwrap<MatchPage>(await api.GET('/api/images/selection-chunk', { params: { query: { selection_token: token, offset, limit } }, signal })),
  }
}

export interface ConditionMatches {
  /** The batch's Library images the condition matches; null when there is no condition. */
  keys: ReadonlySet<string> | null
  /** Batch images outside the Library (folder images): the condition does not apply to them. */
  outside: number
  searching: boolean
  error: string | null
}

/**
 * The batch entries a library search condition matches (V3.5's queue: the
 * library's matches intersected with the batch), kept to favorites when the
 * condition says "only favorites".
 */
function useConditionMatches(condition: string, onlyFavorites: boolean, entries: readonly Entry[]): ConditionMatches {
  const libraryId = useApp((s) => s.libraryId)
  const text = condition.trim()
  const settled = useSettled(text)
  const params = useMemo(() => (settled && !isEverything(settled) ? toImageParams(parseSearch(settled), WHOLE_LIBRARY, 'newest') : null), [settled])
  const libraryIds = useMemo(() => entries.flatMap((entry) => (entry.imageId === null ? [] : [entry.imageId])).sort((a, b) => a - b), [entries])
  const query = useQuery({
    queryKey: ['batch-condition', libraryId, params, libraryIds.join(',')],
    enabled: params !== null,
    queryFn: ({ signal }) => intersectPages(serverPages(params ?? {}, signal), libraryIds),
    staleTime: 30_000,
  })
  const favorites = useFavorites()
  const favoriteIds = onlyFavorites ? favorites.data?.ids : undefined
  const keys = useMemo(() => {
    const byText = params && query.data ? matchKeys(entries, [...query.data]) : null
    if (!onlyFavorites) return byText
    return favoriteIds && (params === null || byText) ? favoriteKeys(entries, byText, favoriteIds) : null
  }, [params, query.data, entries, onlyFavorites, favoriteIds])
  return {
    keys,
    outside: outsideLibrary(entries),
    searching: settled !== text || (params !== null && query.isFetching) || (onlyFavorites && favorites.isFetching),
    error: params && query.error ? query.error.message : null,
  }
}

/** The batch entries a library search condition matches, asked once (a profile rule); an empty condition matches every entry. */
export async function matchCondition(condition: string, entries: readonly Entry[]): Promise<ReadonlySet<string>> {
  const text = condition.trim()
  if (!text || isEverything(text)) return new Set(entries.map((entry) => entry.key))
  const params = toImageParams(parseSearch(text), WHOLE_LIBRARY, 'newest')
  const libraryIds = entries.flatMap((entry) => (entry.imageId === null ? [] : [entry.imageId])).sort((a, b) => a - b)
  const found = await intersectPages(serverPages(params, new AbortController().signal), libraryIds)
  return matchKeys(entries, [...found])
}

/** A step's view of a batch: the entries the name filter shows, and what the condition matches. */
export function useStepView(batchId: number, entries: readonly Entry[]) {
  const key = useViewKey(batchId)
  const name = useStepViews((s) => s.names[key] ?? '')
  const condition = useStepViews((s) => s.conditions[key] ?? '')
  const onlyFavorites = useStepViews((s) => s.favorites[key] ?? false)
  const shown = useMemo(() => byName(entries, name), [entries, name])
  const shownSet = useMemo(() => shownKeys(entries, name), [entries, name])
  const matches = useConditionMatches(condition, onlyFavorites, entries)
  return { key, name, condition, onlyFavorites, shown, shownSet, matches }
}

export type StepView = ReturnType<typeof useStepView>
