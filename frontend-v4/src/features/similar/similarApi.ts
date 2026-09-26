import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '../../api/client'
import type { ImageSummary } from '../../api/types'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { addJob, isQueueBusy, startingProgress, tr } from '../jobs/jobs'
import { busyText } from '../jobs/busyText'
import { withExisting, type DupGroup, type DupPage } from './duplicates'
import { mergeRanked, readHits, type Hit, type RankedImage } from './ranking'
import { queryKeyOf, type SimilarQuery } from './similarStore'

// The similarity and duplicate endpoints, and the jobs that fill them. The
// ranked endpoints give ids; POST /api/images/by-ids turns them into gallery
// rows (not in the generated schema yet, so it goes through plain fetch).

/** Ranked results per page for the searches that page (by meaning, by file). */
export const RANK_PAGE = 100
/** "Find similar" asks for the nearest images of one image (the endpoint's most). */
export const NEAR_LIMIT = 200

const library = () => useApp.getState().libraryId

async function readError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { detail?: unknown; message?: unknown } | null
  const reason = typeof body?.detail === 'string' ? body.detail : typeof body?.message === 'string' ? body.message : res.statusText
  return new ApiError(res.status, reason, null, body)
}

async function post<T>(url: string, body: BodyInit, json = true): Promise<T> {
  const headers: Record<string, string> = { 'X-SD-Library-Id': library() }
  if (json) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, { method: 'POST', headers, body })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as T
}

/** Gallery rows for these ids, in order; gone ones left out. */
export async function imagesByIds(ids: readonly number[]): Promise<ImageSummary[]> {
  if (!ids.length) return []
  return (await post<{ images: ImageSummary[] }>('/api/images/by-ids', JSON.stringify({ image_ids: ids }))).images
}

interface RankedPage {
  images: RankedImage[]
  nextOffset: number | null
}

async function rankedHits(q: SimilarQuery, offset: number): Promise<{ hits: Hit[]; hasMore: boolean }> {
  if (q.kind === 'text') {
    const res = await post<{ results?: unknown; has_more?: boolean }>(
      '/api/similarity/search-text',
      JSON.stringify({ query: q.text, limit: RANK_PAGE, offset, threshold: 0 }),
    )
    return { hits: readHits(res.results), hasMore: res.has_more === true }
  }
  if (q.kind === 'upload') {
    const form = new FormData()
    form.append('file', q.file, q.file.name)
    const res = await post<{ results?: unknown; has_more?: boolean }>(
      `/api/similarity/search-upload?limit=${RANK_PAGE}&offset=${offset}&threshold=0`,
      form,
      false,
    )
    return { hits: readHits(res.results), hasMore: res.has_more === true }
  }
  const res = unwrap<{ results?: unknown }>(
    await api.GET('/api/similarity/near/{image_id}', { params: { path: { image_id: q.id }, query: { limit: NEAR_LIMIT } } }),
  )
  return { hits: readHits(res.results), hasMore: false }
}

async function fetchRanked(q: SimilarQuery, offset: number): Promise<RankedPage> {
  const { hits, hasMore } = await rankedHits(q, offset)
  const rows = await imagesByIds(hits.map((h) => h.id))
  const images = mergeRanked(hits, rows, q.kind === 'image' && q.near)
  return { images, nextOffset: hasMore ? offset + hits.length : null }
}

/** The images ranked for a query, page by page. */
export function useRankedImages(q: SimilarQuery | null) {
  const libraryId = useApp((s) => s.libraryId)
  return useInfiniteQuery({
    queryKey: ['similar', libraryId, q ? queryKeyOf(q) : null],
    enabled: q !== null,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchRanked(q as SimilarQuery, pageParam),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    retry: false,
    staleTime: 60_000,
  })
}

export interface IndexStats {
  total_images: number
  embedded_count: number
  pending_count: number
  unreadable_count: number
}

/** How much of the library is in the similarity index. */
export function useIndexStats(enabled = true) {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['similarity-stats', libraryId],
    enabled,
    queryFn: async ({ signal }) => unwrap<IndexStats>(await api.GET('/api/similarity/stats', { signal })),
    staleTime: 60_000,
  })
}

/** Groups shown per page of the duplicate review. */
export const REVIEW_PAGE = 30
const ID_CHUNK = 2000

async function groupsPage(offset: number, limit: number): Promise<DupPage> {
  return unwrap<DupPage>(await api.GET('/api/duplicates/groups', { params: { query: { offset, limit } } }))
}

/** Which of these ids still exist (the scan's result does not know what was removed since). */
async function stillThere(groups: readonly DupGroup[]): Promise<Set<number>> {
  const ids = [...new Set(groups.flatMap((g) => g.members.map((m) => m.id)))]
  const found = new Set<number>()
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    for (const row of await imagesByIds(ids.slice(i, i + ID_CHUNK))) found.add(row.id)
  }
  return found
}

export interface ReviewPage {
  page: DupPage
  groups: DupGroup[]
  nextOffset: number | null
}

async function reviewPage(offset: number): Promise<ReviewPage> {
  const page = await groupsPage(offset, REVIEW_PAGE)
  const groups = withExisting(page.groups, await stillThere(page.groups))
  return { page, groups, nextOffset: page.has_more ? offset + page.groups.length : null }
}

/** The last duplicate scan, page by page, without images removed since. */
export function useDuplicateReview(enabled = true) {
  const libraryId = useApp((s) => s.libraryId)
  return useInfiniteQuery({
    queryKey: ['duplicates', libraryId, 'review'],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => reviewPage(pageParam),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    staleTime: 30_000,
  })
}

/** Every group of the last scan that still has two images (for "apply every suggestion"). */
export async function fetchAllGroups(): Promise<DupGroup[]> {
  const all: DupGroup[] = []
  for (let offset = 0; ; ) {
    const page = await groupsPage(offset, 200)
    all.push(...page.groups)
    if (!page.has_more || !page.groups.length) break
    offset += page.groups.length
  }
  return withExisting(all, await stillThere(all))
}

/** CLIP cosine between two images (either may be embedded on the spot). */
export async function compareScore(a: number, b: number): Promise<number> {
  const res = unwrap<{ similarity: number }>(await api.GET('/api/similarity/compare', { params: { query: { id_a: a, id_b: b } } }))
  return res.similarity
}

const failed = (error: unknown) => {
  const busy = error instanceof ApiError && error.status === 409
  useToasts.getState().push(busy ? busyText(error) : tr('error.generic', { reason: (error as Error).message }), 'error')
  return false
}

/** Put every image that is not in the similarity index yet into it, as a job. */
export async function startIndexing(): Promise<boolean> {
  if (isQueueBusy('embed')) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return false
  }
  try {
    const res = unwrap<{ status?: string; progress?: unknown }>(await api.POST('/api/similarity/embed', { body: {} }))
    addJob({ kind: 'embed', progress: startingProgress(0) })
    return res.status === 'started' || res.status === 'already_running'
  } catch (error) {
    return failed(error)
  }
}

/** Scan the whole library for near-duplicate groups, as a job. */
export async function startDuplicateScan(threshold: number): Promise<boolean> {
  if (isQueueBusy('dupscan')) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return false
  }
  try {
    const res = unwrap<{ job_id: string }>(await api.POST('/api/duplicates/scan', { body: { threshold } }))
    addJob({ kind: 'dupscan', ctx: { bulkJobId: res.job_id }, progress: { ...startingProgress(100), status: 'queued' } })
    return true
  } catch (error) {
    return failed(error)
  }
}
