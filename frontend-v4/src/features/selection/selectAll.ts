import { create } from 'zustand'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { useApp } from '../../state/store'
import { matchingIds } from './invert'

// "Select all N" of the library: every image the filter matches is picked
// (the server answers their ids for the filter, not only the loaded pages).
// The selection bar's button and anything that opens the library on a set
// of pictures with all of them picked (the Style Map's "Show in Library")
// call this one function; `useCovered` remembers which filter is fully
// picked, so the bar stops offering "Select all" for it.

export interface Covered {
  /** The filter, as JSON.stringify(params). */
  key: string
  size: number
}

export const useCovered = create<{ covered: Covered | null }>(() => ({ covered: null }))

export const coverKey = (params: ImageQueryParams): string => JSON.stringify(params)

export const forgetCovered = (): void => useCovered.setState({ covered: null })

// Picks cleared (Esc, Clear, another library): no filter is fully picked any more.
useApp.subscribe((s, prev) => {
  if (s.selection.length === 0 && prev.selection.length > 0 && useCovered.getState().covered) forgetCovered()
})

/**
 * Pick every image the filter matches: added to the picks, or in place of
 * them with `replace`. Resolves how many the filter matched; throws when the
 * server could not answer (the picks are left as they were).
 */
export async function selectAllMatches(params: ImageQueryParams, { replace = false }: { replace?: boolean } = {}): Promise<number> {
  const ids = await matchingIds(params)
  const s = useApp.getState()
  let next = ids
  if (!replace) {
    const have = new Set(s.selection)
    next = [...s.selection, ...ids.filter((id) => !have.has(id))]
  }
  s.setSelection(next)
  useCovered.setState({ covered: { key: coverKey(params), size: next.length } })
  return ids.length
}
