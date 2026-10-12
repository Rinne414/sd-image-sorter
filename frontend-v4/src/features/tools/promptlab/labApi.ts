import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError, api, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { CategorizeResponse, TagCategory } from '../../../api/types'
import { useApp } from '../../../state/store'
import type { CompareResult, PromptStats } from './types'

/** Categories for these words, from the same cache useCategories fills. */
export async function fetchCategories(words: readonly string[]): Promise<Map<string, TagCategory>> {
  const key = [...new Set(words)].sort()
  if (key.length === 0) return new Map()
  return queryClient.fetchQuery({
    queryKey: ['categorize', key.join('|')],
    queryFn: async ({ signal }) => {
      const res = unwrap<CategorizeResponse>(await api.POST('/api/prompts/categorize', { body: key, signal }))
      return new Map(res.results.map((row) => [row.tag, row.category] as const))
    },
    staleTime: Infinity,
  })
}

// The two reads 提示词助手 makes for Stats and Compare.

/** How many rows of each list are shown; "显示更多" raises one. */
export interface Visible {
  tags: number
  high: number
  models: number
  leaders: number
  recipes: number
  examples: number
}

export const FIRST_VISIBLE: Visible = { tags: 20, high: 20, models: 12, leaders: 8, recipes: 8, examples: 8 }
export const MORE_STEP: Visible = { tags: 20, high: 20, models: 12, leaders: 8, recipes: 8, examples: 8 }

/** Asked for up front, so the first few "显示更多" need no new request. */
const FETCH_FLOOR: Visible = { tags: 100, high: 100, models: 30, leaders: 24, recipes: 24, examples: 24 }

export function fetchLimits(visible: Visible) {
  const at = (k: keyof Visible) => Math.max(visible[k], FETCH_FLOOR[k])
  return {
    tag_limit: at('tags'),
    high_tag_limit: at('high'),
    checkpoint_limit: at('models'),
    leader_limit: at('leaders'),
    recipe_limit: at('recipes'),
    scored_limit: at('examples'),
  }
}

export function usePromptStats(visible: Visible) {
  const libraryId = useApp((s) => s.libraryId)
  const query = fetchLimits(visible)
  return useQuery({
    queryKey: ['prompt-stats', libraryId, query],
    queryFn: async ({ signal }) => unwrap<PromptStats>(await api.GET('/api/prompts/stats', { params: { query }, signal })),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export type CompareProblem = 'missing' | 'notFound' | 'other'

/** Why a compare failed, in the words the user needs (the backend's reason is English). */
export function compareProblem(error: unknown): CompareProblem {
  if (error instanceof ApiError && error.status === 409) return 'missing'
  if (error instanceof ApiError && error.status === 404) return 'notFound'
  return 'other'
}

export function useCompare(a: number | null, b: number | null) {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['prompt-compare', libraryId, a, b],
    enabled: a !== null && b !== null && a !== b,
    queryFn: async ({ signal }) =>
      unwrap<CompareResult>(await api.GET('/api/prompts/compare', { params: { query: { id_a: a as number, id_b: b as number } }, signal })),
    retry: false,
    staleTime: 30_000,
  })
}
