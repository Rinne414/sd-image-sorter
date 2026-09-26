import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../../api/client'
import type { Batch, BatchProjectView } from '../../../api/types'
import { translate, useLang } from '../../../i18n'
import { useApp } from '../../../state/store'
import { previewBody } from '../captionRules'
import type { DatasetForm } from '../datasetSettings'
import type { HeadInfo } from '../datasetTag'
import type { Entry } from '../entries'
import { rowKey, type PreviewRow } from '../edit/captionContent'
import { PREVIEW_CHUNK } from '../edit/initialContents'
import { readAuditReport, type AuditReport, type HealthReport, type ReviewIssueRow } from './checkIssues'
import type { CheckOptions } from './checkOptions'

// The check step's requests. Each source is its own query, so issues show as
// each answers and one that fails says so without hiding the others. The
// costly ones (the review queue, the audit) run again only when asked
// ("Check again", a new threshold): `run` is in their keys.

/** Library images that still exist, by id, and folder images still on disk. */
export function checkScope(entries: readonly Entry[]) {
  const ids = [...new Set(entries.flatMap((e) => (e.imageId === null ? [] : [e.imageId])))]
  const paths = entries.flatMap((e) => (e.imageId === null && e.path !== null && e.status === 'ok' ? [e.path] : []))
  const folderCount = entries.filter((e) => e.ref.kind === 'folder').length
  return { ids, paths, folderCount }
}

/** The entries a check over every image sends (the ones checkScope names), by key. */
export function sentKeys(entries: readonly Entry[]): string[] {
  return entries.flatMap((e) => (e.imageId !== null || (e.path !== null && e.status === 'ok') ? [e.key] : []))
}

export interface Finals {
  /** The caption the export writes for each image now, by entry key. */
  captions: Map<string, string>
  /** Images the preview could not render (their reason). */
  failed: Map<string, string>
}

/** Every image's final caption: its revision (or the template) under the batch rules, as the export sends. */
export function useFinalCaptions(
  batch: Batch,
  view: BatchProjectView | undefined,
  form: DatasetForm | null,
  entries: readonly Entry[],
  heads: ReadonlyMap<string, HeadInfo> | undefined,
) {
  const library = useApp((s) => s.libraryId)
  const revisions = heads ? [...heads.entries()].map(([k, h]) => `${k}=${h.revisionId ?? 0}`).join('|') : null
  return useQuery({
    queryKey: ['dataset-preview', 'check', library, batch.id, view?.project.revision, form ? JSON.stringify(form) : null, revisions, entries.map((e) => e.key).join('|')],
    enabled: !!view && !!form && !!heads && entries.length > 0,
    queryFn: async ({ signal }): Promise<Finals> => {
      const scope = { projectId: (view as BatchProjectView).project.id, projectRevision: (view as BatchProjectView).project.revision, heads: heads as ReadonlyMap<string, HeadInfo> }
      const byRow = new Map(entries.map((e) => [rowKey(e.imageId ?? 0, e.path), e.key]))
      const captions = new Map<string, string>()
      const failed = new Map<string, string>()
      for (let i = 0; i < entries.length; i += PREVIEW_CHUNK) {
        const body = previewBody(form as DatasetForm, entries.slice(i, i + PREVIEW_CHUNK), PREVIEW_CHUNK, scope)
        if (body.image_ids.length === 0 && body.image_paths.length === 0) continue
        const res = unwrap<{ items: PreviewRow[] }>(await api.POST('/api/dataset/export-preview', { body: body as never, signal }))
        for (const row of res.items) {
          const key = byRow.get(rowKey(row.image_id, row.abs_path))
          if (!key) continue
          const problem = row.error ?? row.skipped_reason
          if (problem) failed.set(key, problem)
          else captions.set(key, row.caption)
        }
      }
      return { captions, failed }
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

interface ReviewPage {
  issues: ReviewIssueRow[]
  has_more: boolean
  next_cursor: string | null
}

/** The backend reviews at most this many Library images per request. */
const REVIEW_MAX_IDS = 20_000

const REVIEW_KINDS = ['file_missing', 'image_unreadable', 'small_image', 'low_aesthetic', 'duplicate_group'] as const

/** Stored evidence about the Library images: missing or unreadable files, small, low aesthetic, saved duplicate groups. */
export function useReviewQueue(batch: Batch, entries: readonly Entry[], o: CheckOptions, ratings: boolean, run: number) {
  const library = useApp((s) => s.libraryId)
  const { ids, folderCount } = checkScope(entries)
  return useQuery({
    queryKey: ['check-review', library, batch.id, run, o.minSide, o.minAesthetic, ratings],
    enabled: ids.length > 0,
    queryFn: async ({ signal }) => {
      const issues: ReviewIssueRow[] = []
      for (let i = 0; i < ids.length; i += REVIEW_MAX_IDS) {
        const chunk = ids.slice(i, i + REVIEW_MAX_IDS)
        let cursor: string | null = null
        for (;;) {
          const body = {
            schema_version: 1 as const,
            image_ids: chunk,
            caption_states: chunk.map((image_id) => ({ image_id, has_content: true })),
            logical_count: Math.max(entries.length, chunk.length + folderCount),
            local_path_count: folderCount,
            minimum_dimension: o.minSide > 0 ? o.minSide : null,
            minimum_aesthetic: o.minAesthetic > 0 ? o.minAesthetic : null,
            include_persisted_duplicates: true,
            issue_kinds: [...REVIEW_KINDS, ...(ratings ? (['rating_conflict'] as const) : [])],
            cursor,
            limit: 200,
          }
          const page: ReviewPage = unwrap<ReviewPage>(await api.POST('/api/dataset/review-queue', { body: body as never, signal }))
          issues.push(...page.issues)
          if (!page.has_more || !page.next_cursor) break
          cursor = page.next_cursor
        }
      }
      return issues
    },
    staleTime: Infinity,
  })
}

export interface AuditAnswer extends AuditReport {
  summary: { near_duplicate_error?: string; near_duplicate_check_limited?: boolean; near_duplicate_failed?: number }
}

/** The audit's cap on per-image rows; the whole batch fits under it. */
const AUDIT_MAX_ITEMS = 50_000

/** The audit's answer, or a readable failure when it came back empty or not the audit's (the source row offers Retry). */
function readAudit(result: Parameters<typeof unwrap>[0]): AuditAnswer {
  return readAuditReport<Pick<AuditAnswer, 'summary'>>(unwrap<unknown>(result), translate(useLang.getState().lang, 'error.badAnswer'))
}

/** Sizes read from disk and perceptual-hash near duplicates across every image (Library and folder). */
export function useAudit(batch: Batch, entries: readonly Entry[], o: CheckOptions, run: number) {
  const library = useApp((s) => s.libraryId)
  const { ids, paths } = checkScope(entries)
  return useQuery({
    queryKey: ['check-audit', library, batch.id, run, o.minSide, o.nearDistance, o.everyPair],
    enabled: ids.length + paths.length > 0,
    queryFn: async ({ signal }) => ({
      /** The images this run looked at (images added later are not in it until "Check again"). */
      sent: sentKeys(entries),
      ...readAudit(
        await api.POST('/api/dataset/audit', {
          body: {
            image_ids: ids,
            image_paths: paths,
            dim_min: o.minSide > 0 ? o.minSide : null,
            phash_max: o.nearDistance,
            enable_phash: true,
            enable_aesthetic: false,
            enable_untagged: false,
            item_limit: Math.min(AUDIT_MAX_ITEMS, ids.length + paths.length),
            near_duplicate_full: o.everyPair,
          } as never,
          signal,
        }),
      ),
    }),
    staleTime: Infinity,
  })
}

/** Folder images scored by the aesthetic model now (they have no stored score); only when asked. */
export function useFolderAesthetic(batch: Batch, entries: readonly Entry[], o: CheckOptions, run: number) {
  const library = useApp((s) => s.libraryId)
  const { paths } = checkScope(entries)
  return useQuery({
    queryKey: ['check-audit-aesthetic', library, batch.id, run, o.minAesthetic],
    enabled: o.scoreFolders && o.minAesthetic > 0 && paths.length > 0,
    queryFn: async ({ signal }) =>
      readAudit(
        await api.POST('/api/dataset/audit', {
          body: { image_paths: paths, aesthetic_max: o.minAesthetic, enable_aesthetic: true, enable_phash: false, enable_untagged: false, item_limit: Math.min(AUDIT_MAX_ITEMS, paths.length) } as never,
          signal,
        }),
      ),
    staleTime: Infinity,
  })
}

/** The health check reads at most this many Library images (the backend says when it stopped short). */
const HEALTH_MAX_IDS = 20_000

/** Health by purpose: trigger, composition, ratings, over the Library images with their final captions. */
export function useHealth(batch: Batch, entries: readonly Entry[], form: DatasetForm | null, finals: Finals | undefined, run: number) {
  const library = useApp((s) => s.libraryId)
  const pairs = entries.flatMap((e) => (e.imageId === null ? [] : [[e.imageId, finals?.captions.get(e.key) ?? ''] as const]))
  const unique = [...new Map(pairs).entries()].slice(0, HEALTH_MAX_IDS)
  const signature = unique.map(([id, c]) => `${id}:${c}`).join('\n')
  return useQuery({
    queryKey: ['check-health', library, batch.id, run, form?.trigger, form?.purpose, signature],
    enabled: !!form && !!finals && unique.length > 0,
    queryFn: async ({ signal }) =>
      unwrap<HealthReport & { images_in_scope: number; images_truncated: boolean }>(
        await api.POST('/api/tags/consistency/report', {
          body: {
            image_ids: unique.map(([id]) => id),
            effective_captions: unique.map(([image_id, caption]) => ({ image_id, caption })),
            trigger: (form as DatasetForm).trigger.trim(),
            training_purpose: (form as DatasetForm).purpose ?? '',
          } as never,
          signal,
        }),
      ),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

export interface TagModelRow {
  model: string
  images: number
  avg_score: number
  max_score: number
  min_score: number
}

/** Which taggers scored this tag on the batch's Library images, and how sure they were. */
export function useTagAudit(tag: string, ids: readonly number[]) {
  const library = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['check-tag-audit', library, tag, ids.join(',')],
    enabled: ids.length > 0,
    queryFn: async ({ signal }) =>
      unwrap<{ scope_images: number; models: TagModelRow[] }>(
        await api.POST('/api/tags/scores/tag-audit', { body: { tag: tag.replace(/ /g, '_'), image_ids: [...ids] }, signal }),
      ),
    staleTime: 60_000,
  })
}

export interface TagInfo {
  canonical: string
  category: string | null
  found_in_vocab: boolean
  danbooru_count: number
  aliases: string[]
  zh: string | null
  implies: string[]
  implied_by: string[]
  library_count: number
}

export function useTagInfo(tag: string) {
  return useQuery({
    queryKey: ['tag-info', tag],
    queryFn: async ({ signal }) => unwrap<TagInfo>(await api.GET('/api/tags/info', { params: { query: { tag: tag.replace(/ /g, '_') } }, signal })),
    staleTime: 5 * 60_000,
  })
}
