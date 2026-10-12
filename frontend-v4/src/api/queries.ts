import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query'
import { api, unwrap } from './client'
import { queryClient } from './queryClient'
import type { paths } from './schema'
import type {
  CategorizeResponse,
  CollectionRow,
  GeneratorCount,
  ImageDetailResponse,
  ImagesPage,
  LibrariesResponse,
  LibraryHealth,
  TagCategory,
} from './types'
import type { ImageQueryParams } from '../lib/searchQuery'
import type { ModelCard } from '../features/tagging/taggers'
import { useApp } from '../state/store'
import { translate, useLang } from '../i18n'
import { useToasts } from '../ui/toasts'

type ImagesQuery = NonNullable<paths['/api/images']['get']['parameters']['query']>

export const PAGE_SIZE = 240

type PageParam = { cursor?: string; offset?: number }

export function useLibraries() {
  return useQuery({
    queryKey: ['libraries'],
    queryFn: async ({ signal }) => unwrap<LibrariesResponse>(await api.GET('/api/libraries', { signal })),
    staleTime: 60_000,
  })
}

export function useImages(params: ImageQueryParams) {
  const libraryId = useApp((s) => s.libraryId)
  return useInfiniteQuery({
    queryKey: ['images', libraryId, params],
    initialPageParam: {} as PageParam,
    queryFn: async ({ pageParam, signal }) => {
      const query = { ...params, limit: PAGE_SIZE, ...pageParam } as ImagesQuery
      return unwrap<ImagesPage>(await api.GET('/api/images', { params: { query }, signal }))
    },
    getNextPageParam: (last): PageParam | undefined => {
      if (!last.has_more) return undefined
      if (last.next_cursor) return { cursor: last.next_cursor }
      if (last.next_offset !== null && last.next_offset !== undefined) return { offset: last.next_offset }
      return undefined
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export function useImageDetail(id: number | null) {
  return useQuery({
    queryKey: ['image', id],
    enabled: id !== null,
    queryFn: async ({ signal }) =>
      unwrap<ImageDetailResponse>(
        await api.GET('/api/images/{image_id}', { params: { path: { image_id: id as number } }, signal }),
      ),
    staleTime: 60_000,
  })
}

/** Semantic category (14 kinds) for each tag, used to colour prompts and chips. */
export function useCategories(tags: string[]) {
  const key = [...new Set(tags)].sort()
  return useQuery({
    queryKey: ['categorize', key.join('|')],
    enabled: key.length > 0,
    queryFn: async ({ signal }) => {
      const res = unwrap<CategorizeResponse>(await api.POST('/api/prompts/categorize', { body: key, signal }))
      const map = new Map<string, TagCategory>()
      for (const row of res.results) map.set(row.tag, row.category)
      return map
    },
    staleTime: Infinity,
  })
}

export function useGenerators() {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['generators', libraryId],
    queryFn: async ({ signal }) =>
      unwrap<{ generators: GeneratorCount[] }>(await api.GET('/api/generators', { signal })).generators,
    staleTime: 60_000,
  })
}

export function useFolders() {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['folders', libraryId],
    queryFn: async ({ signal }) => unwrap<{ folders: string[] }>(await api.GET('/api/folders', { signal })).folders,
    staleTime: 60_000,
  })
}

export function useLibraryHealth() {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['library-health', libraryId],
    queryFn: async ({ signal }) => unwrap<LibraryHealth>(await api.GET('/api/library-health', { signal })),
    staleTime: 60_000,
  })
}

export function useMissingCount() {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['missing-summary', libraryId],
    queryFn: async ({ signal }) =>
      unwrap<{ total: number }>(await api.GET('/api/images/missing-summary', { signal })).total,
    staleTime: 60_000,
  })
}

export function useFavorites() {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['favorites', libraryId],
    queryFn: async ({ signal }) => {
      const [ids, cols] = await Promise.all([
        api.GET('/api/collections/favorites/ids', { signal }).then((r) => unwrap<{ image_ids: number[] }>(r)),
        api.GET('/api/collections', { signal }).then((r) => unwrap<{ collections: CollectionRow[] }>(r)),
      ])
      const fav = cols.collections.find((c) => c.slug === 'favorites')
      return { ids: new Set(ids.image_ids), collectionId: fav?.id ?? null }
    },
    staleTime: 30_000,
  })
}

type ImagesData = InfiniteData<ImagesPage, PageParam>

type FavoritesData = { ids: Set<number>; collectionId: number | null }

function reportWriteError(error: Error): void {
  const lang = useLang.getState().lang
  useToasts.getState().push(translate(lang, 'error.saveFailed', { reason: error.message }), 'error')
}

export function useSetRating() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ ids, stars }: { ids: number[]; stars: number }) => {
      for (const id of ids) {
        unwrap(await api.POST('/api/images/{image_id}/rating', { params: { path: { image_id: id } }, body: { stars } }))
      }
    },
    onMutate: ({ ids, stars }) => {
      const lists = qc.getQueriesData<ImagesData>({ queryKey: ['images'] })
      const details = ids.map((id) => [id, qc.getQueryData<ImageDetailResponse>(['image', id])] as const)
      const hit = new Set(ids)
      qc.setQueriesData<ImagesData>({ queryKey: ['images'] }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((p) => ({
                ...p,
                images: p.images.map((img) => (hit.has(img.id) ? { ...img, user_rating: stars } : img)),
              })),
            }
          : data,
      )
      for (const id of ids) {
        qc.setQueryData<ImageDetailResponse>(['image', id], (d) =>
          d ? { ...d, image: { ...d.image, user_rating: stars } } : d,
        )
      }
      return { lists, details }
    },
    onError: (error, _vars, snapshot) => {
      for (const [key, data] of snapshot?.lists ?? []) qc.setQueryData(key, data)
      for (const [id, data] of snapshot?.details ?? []) qc.setQueryData(['image', id], data)
      // Some ids may have been saved before the failure: fetch the truth.
      void qc.invalidateQueries({ queryKey: ['images'] })
      void qc.invalidateQueries({ queryKey: ['image'] })
      reportWriteError(error)
    },
  })
}

export function useToggleFavorite() {
  const qc = useQueryClient()
  const libraryId = useApp((s) => s.libraryId)
  return useMutation({
    mutationFn: async ({ ids, favorited }: { ids: number[]; favorited: boolean }) => {
      for (const id of ids) {
        unwrap(await api.POST('/api/collections/favorites', { body: { image_id: id, favorited } }))
      }
    },
    onMutate: ({ ids, favorited }) => {
      const before = qc.getQueryData<FavoritesData>(['favorites', libraryId])
      qc.setQueryData<FavoritesData>(['favorites', libraryId], (d) => {
        if (!d) return d
        const next = new Set(d.ids)
        for (const id of ids) {
          if (favorited) next.add(id)
          else next.delete(id)
        }
        return { ...d, ids: next }
      })
      return { before }
    },
    onError: (error, _vars, snapshot) => {
      if (snapshot?.before) qc.setQueryData(['favorites', libraryId], snapshot.before)
      void qc.invalidateQueries({ queryKey: ['favorites'] })
      reportWriteError(error)
    },
  })
}

type SuggestEndpoint = 'tags' | 'checkpoints' | 'loras' | 'prompts'

const SUGGEST_FIELD: Record<SuggestEndpoint, string> = {
  tags: 'tag',
  checkpoints: 'checkpoint',
  loras: 'lora',
  prompts: 'prompt',
}

/** Values from the library for a key:partial token, most used first. */
export function useLibrarySuggest(endpoint: SuggestEndpoint | null, prefix: string) {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['suggest', libraryId, endpoint, prefix],
    enabled: endpoint !== null && prefix.length > 0,
    queryFn: async ({ signal }) => {
      const url = `/api/${endpoint}/library?q=${encodeURIComponent(prefix)}&limit=10`
      const res = await fetch(url, { signal, headers: { 'X-SD-Library-Id': libraryId } })
      if (!res.ok) return []
      const body = (await res.json()) as Record<string, { count?: number }[] | undefined>
      const field = SUGGEST_FIELD[endpoint as SuggestEndpoint]
      return (body[endpoint as string] ?? []).map((row) => ({
        value: String((row as Record<string, unknown>)[field] ?? ''),
        count: row.count,
      }))
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
}

/** How many images match these params (smart filter counts). */
export function useImageCount(params: ImageQueryParams | null) {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['image-count', libraryId, params],
    enabled: params !== null,
    queryFn: async ({ signal }) => {
      const qs = new URLSearchParams(Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]))
      qs.delete('sort_by')
      const res = await fetch(`/api/images/count?${qs}`, { signal, headers: { 'X-SD-Library-Id': libraryId } })
      if (!res.ok) throw new Error(res.statusText)
      return ((await res.json()) as { total: number }).total
    },
    staleTime: 30_000,
  })
}

export interface TaggerModel {
  name: string
  disabled: boolean
  default_threshold: number
  default_character_threshold: number
  /** null: copyright tags use the general threshold. */
  default_copyright_threshold?: number | null
  default_max_tags_per_image: number
  recommended: boolean
}

const taggerModelsQuery = {
  queryKey: ['tagger-models'],
  queryFn: async ({ signal }: { signal?: AbortSignal }) =>
    unwrap<{ models: TaggerModel[]; default: string }>(await api.GET('/api/tagger/models', { signal })),
  staleTime: 5 * 60_000,
}

/** Tagger models the backend offers, and its default. */
export function useTaggerModels() {
  return useQuery(taggerModelsQuery)
}

export const fetchModelStatus = async (signal?: AbortSignal) =>
  unwrap<{ models: ModelCard[] }>(await api.GET('/api/models/status', { signal }))

const modelStatusQuery = {
  queryKey: ['model-status'],
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchModelStatus(signal),
  staleTime: 30_000,
}

/** Which AI models are on disk (the Model Center cards). */
export function useModelStatus() {
  return useQuery(modelStatusQuery)
}

/** Start loading what the tag panel shows (the status takes about a second), e.g. on hover. */
export function prefetchTagging(): void {
  void queryClient.prefetchQuery(taggerModelsQuery)
  void queryClient.prefetchQuery(modelStatusQuery)
}
