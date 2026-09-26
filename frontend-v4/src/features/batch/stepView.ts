import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { parseSearch, toImageParams, type ScopeFilter } from '../../lib/searchQuery'
import { useApp } from '../../state/store'
import { matchingIds } from '../selection/invert'
import { isEverything } from '../sort/rules'
import { byName, matchKeys, shownKeys } from './batchFilter'
import type { Entry } from './entries'
import { NO_HISTORY, pushOrder, undoOrder, type OrderHistory } from './orderHistory'

// What each batch's steps show and can undo, per library and batch, while the
// app is open: the name filter and condition (shared by Pick, Censor and
// Order, so they carry from step to step) and the reorder history.

interface State {
  names: Readonly<Record<string, string>>
  conditions: Readonly<Record<string, string>>
  histories: Readonly<Record<string, OrderHistory>>
  setName: (key: string, text: string) => void
  setCondition: (key: string, text: string) => void
  /** Remember the order before a reorder. */
  record: (key: string, order: readonly string[]) => void
  /** The order before the last reorder, taken off the history; null when there is none. */
  takeUndo: (key: string) => readonly string[] | null
}

export const useStepViews = create<State>((set, get) => ({
  names: {},
  conditions: {},
  histories: {},
  setName: (key, text) => set((s) => ({ names: { ...s.names, [key]: text } })),
  setCondition: (key, text) => set((s) => ({ conditions: { ...s.conditions, [key]: text } })),
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

export interface ConditionMatches {
  /** The batch entries the condition matches; null when there is no condition. */
  keys: ReadonlySet<string> | null
  searching: boolean
  error: string | null
}

/**
 * The batch entries a library search condition matches: the library's
 * "every match" list (POST /api/images/selection-ids, the same filters as the
 * gallery) intersected with the batch, as V3.5's queue did.
 */
function useConditionMatches(condition: string, entries: readonly Entry[]): ConditionMatches {
  const libraryId = useApp((s) => s.libraryId)
  const text = condition.trim()
  const settled = useSettled(text)
  const params = useMemo(() => (settled && !isEverything(settled) ? toImageParams(parseSearch(settled), WHOLE_LIBRARY, 'newest') : null), [settled])
  const query = useQuery({
    queryKey: ['batch-condition', libraryId, params],
    enabled: params !== null,
    queryFn: () => matchingIds(params ?? {}),
    staleTime: 30_000,
  })
  const keys = useMemo(() => (params && query.data ? matchKeys(entries, query.data) : null), [params, query.data, entries])
  return {
    keys,
    searching: settled !== text || (params !== null && query.isFetching),
    error: params && query.error ? query.error.message : null,
  }
}

/** A step's view of a batch: the entries the name filter shows, and what the condition matches. */
export function useStepView(batchId: number, entries: readonly Entry[]) {
  const key = useViewKey(batchId)
  const name = useStepViews((s) => s.names[key] ?? '')
  const condition = useStepViews((s) => s.conditions[key] ?? '')
  const shown = useMemo(() => byName(entries, name), [entries, name])
  const shownSet = useMemo(() => shownKeys(entries, name), [entries, name])
  const matches = useConditionMatches(condition, entries)
  return { key, name, condition, shown, shownSet, matches }
}

export type StepView = ReturnType<typeof useStepView>
