import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { CategorizeResponse, TagCategory } from '../../../api/types'
import { useApp } from '../../../state/store'
import type { LexTab } from './lexiconQuery'
import { fromPayload, type LexRow } from './lexiconRows'

// 词库's reads: the whole list of one tab (the library on screen), the
// category of every tag, and changing one tag's category.

async function fetchTab(tab: LexTab, signal: AbortSignal): Promise<LexRow[]> {
  const opts = { signal }
  if (tab === 'tags') return fromPayload(tab, unwrap(await api.GET('/api/tags/library', { params: { query: { sort_by: 'frequency' } }, ...opts })))
  if (tab === 'prompts') return fromPayload(tab, unwrap(await api.GET('/api/prompts/library', opts)))
  if (tab === 'loras') return fromPayload(tab, unwrap(await api.GET('/api/loras/library', opts)))
  return fromPayload(tab, unwrap(await api.GET('/api/checkpoints/library', opts)))
}

/** Every entry of this tab, with how many images of the library use it. */
export function useLexicon(tab: LexTab) {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['lexicon', libraryId, tab],
    queryFn: ({ signal }) => fetchTab(tab, signal),
    staleTime: 60_000,
  })
}

/** Tags per categorize request (the backend answers ~10k in a third of a second). */
const CHUNK = 5000

async function categorizeAll(tags: readonly string[], signal: AbortSignal): Promise<Map<string, TagCategory>> {
  const map = new Map<string, TagCategory>()
  for (let at = 0; at < tags.length; at += CHUNK) {
    const body = tags.slice(at, at + CHUNK)
    const res = unwrap<CategorizeResponse>(await api.POST('/api/prompts/categorize', { body, signal }))
    for (const row of res.results) map.set(row.tag, row.category)
  }
  return map
}

const categoriesKey = (libraryId: string) => ['lexicon-categories', libraryId]

/** The category of every tag in the list (the user's own choices included). */
export function useTagCategories(tags: readonly string[] | undefined) {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: [...categoriesKey(libraryId), tags?.length ?? 0],
    enabled: !!tags?.length,
    queryFn: ({ signal }) => categorizeAll(tags ?? [], signal),
    staleTime: 60_000,
  })
}

/** Move a tag to another category (saved as the user's choice), and show it everywhere. */
export async function recategorize(tag: string, category: TagCategory): Promise<void> {
  unwrap(await api.POST('/api/prompts/recategorize', { params: { query: { tag, category } } }))
  const libraryId = useApp.getState().libraryId
  queryClient.setQueriesData<Map<string, TagCategory>>({ queryKey: categoriesKey(libraryId) }, (old) => {
    if (!old) return old
    const next = new Map(old)
    next.set(tag, category)
    return next
  })
  // the tag colours on cards and chips, and Prompt Lab's random pool
  for (const key of ['categorize', 'prompt-categories']) void queryClient.invalidateQueries({ queryKey: [key] })
}
