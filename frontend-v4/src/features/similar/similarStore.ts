import { create } from 'zustand'
import { useApp } from '../../state/store'
import { DEFAULT_THRESHOLD, type SearchOptions } from './searchRequest'

// "Find a different way": the library can show images ranked by likeness
// instead of by the filter — to a sentence (semantic search), to an image of
// the library (find similar / near-duplicates) or to an image file (search by
// image). The filter stays as it was and comes back when this is cleared.

export type SimilarQuery =
  | { kind: 'text'; text: string }
  | { kind: 'image'; id: number; name: string; near: boolean }
  | { kind: 'upload'; file: File; token: number }

interface SimilarState {
  query: SimilarQuery | null
  /** The query bar searches by meaning instead of by the filter language. */
  semantic: boolean
  /** Threshold and scope of the searches (kept for the session, as in V3.5). */
  options: SearchOptions
  show: (query: SimilarQuery) => void
  clear: () => void
  setSemantic: (on: boolean) => void
  setOptions: (patch: Partial<SearchOptions>) => void
}

export const useSimilar = create<SimilarState>((set, get) => ({
  query: null,
  semantic: false,
  options: { threshold: DEFAULT_THRESHOLD, collectionId: null },
  show: (query) => set({ query }),
  clear: () => set({ query: null }),
  setSemantic: (semantic) => set({ semantic }),
  setOptions: (patch) => set({ options: { ...get().options, ...patch } }),
}))

let uploads = 0

/** Search by an image file (dropped on the query bar or picked). */
export function showUpload(file: File): void {
  useSimilar.getState().show({ kind: 'upload', file, token: ++uploads })
}

/** Find images like one of the library's own, in the library. */
export function showLikeImage(id: number, name: string, near: boolean): void {
  const s = useApp.getState()
  if (s.page !== 'library') s.setPage('library')
  useSimilar.getState().show({ kind: 'image', id, name, near })
}

// Ranked results and collections belong to one library.
useApp.subscribe((s, prev) => {
  if (s.libraryId === prev.libraryId) return
  useSimilar.getState().clear()
  useSimilar.getState().setOptions({ collectionId: null })
})

/** A stable cache key for a query (a file is known by its upload token). */
export function queryKeyOf(q: SimilarQuery): string {
  if (q.kind === 'text') return `text:${q.text}`
  if (q.kind === 'image') return `image:${q.id}:${q.near ? 'near' : 'like'}`
  return `upload:${q.token}`
}
