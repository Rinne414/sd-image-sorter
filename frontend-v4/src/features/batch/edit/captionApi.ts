import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { Batch, BatchProjectView } from '../../../api/types'
import type { MessageKey } from '../../../i18n'
import { useApp } from '../../../state/store'
import { tr } from '../../jobs/jobs'
import { DEFAULT_TEMPLATE, previewBody } from '../captionRules'
import { projectKey } from '../datasetApi'
import { pathKey } from '../datasetItems'
import { splitList, type DatasetForm } from '../datasetSettings'
import type { Author, CaptionContent, HeadInfo } from '../datasetTag'
import { headInfo, headsKey, type HeadRow } from '../datasetTagApi'
import type { Entry } from '../entries'
import { initialContent, initialTemplate, type StoredText } from './captionContent'
import type { HeadSnapshot, SaveOutcome } from './captionSession'

// The caption editor's requests. Saves and restores name the project
// revision and the head generation they were made on; the answer updates the
// batch's cached heads so every step (and the preview) sees the new revision.

const libraryId = () => useApp.getState().libraryId

type Subject = { item_type: 'library'; image_id: number } | { item_type: 'local'; path: string }

/** Whom a caption belongs to; null when there is nothing left to caption (the image is gone). */
export function subjectOf(entry: Entry): Subject | null {
  if (entry.ref.kind === 'library') return entry.imageId === null ? null : { item_type: 'library', image_id: entry.ref.imageId }
  if (entry.status !== 'ok') return null
  return { item_type: 'local', path: entry.ref.path }
}

/** Why this image's caption cannot be edited, or null. */
export function lockedReason(entry: Entry): MessageKey | null {
  if (entry.ref.kind === 'library') return entry.imageId === null ? 'dataset.edit.libraryGone' : null
  if (entry.status === 'missing') return 'dataset.edit.fileGone'
  if (entry.status === 'changed') return 'dataset.edit.fileChanged'
  return null
}

export const snapshotOf = (info: HeadInfo | undefined): HeadSnapshot =>
  info
    ? {
        generation: info.generation,
        revisionId: info.revisionId ?? null,
        subjectId: info.subjectId ?? null,
        author: info.author,
        content: info.content ?? null,
      }
    : { generation: 0, revisionId: null, subjectId: null, author: null, content: null }

/** The project as the batch sees it now (read again when asked to). */
async function readView(batchId: number, fresh = false): Promise<BatchProjectView> {
  const key = projectKey(libraryId(), batchId)
  const cached = fresh ? undefined : queryClient.getQueryData<BatchProjectView>(key)
  if (cached) return cached
  return queryClient.fetchQuery({
    queryKey: key,
    queryFn: async () => unwrap<BatchProjectView>(await api.GET('/api/batches/{batch_id}/project', { params: { path: { batch_id: batchId } } })),
    staleTime: 0,
  })
}

/** Keep the new head in every cached copy of this project's heads. */
function remember(projectId: number, key: string, info: HeadInfo): void {
  queryClient.setQueriesData<Map<string, HeadInfo>>({ queryKey: headsKey(libraryId(), projectId).slice(0, 3) }, (old) =>
    old ? new Map(old).set(key, info) : old,
  )
}

function reasonOf(error: unknown): string {
  const code = error instanceof ApiError ? error.code : null
  if (code === 'annotation_project_state_conflict') return tr('dataset.archivedNoEdit')
  if (code === 'annotation_subject_not_in_project') return tr('dataset.edit.notInProject')
  if (code === 'annotation_subject_identity_conflict') return tr('dataset.edit.fileChanged')
  return (error as Error).message
}

const isCode = (error: unknown, code: string) => error instanceof ApiError && error.code === code

type Write = (view: BatchProjectView) => Promise<HeadRow>

/** A write with the project revision; the project read again once when V4 or V3.5 changed it meanwhile. */
async function writeHead(batchId: number, key: string, subject: Subject, write: Write): Promise<SaveOutcome> {
  let view = await readView(batchId)
  try {
    let row: HeadRow
    try {
      row = await write(view)
    } catch (error) {
      if (!isCode(error, 'annotation_project_revision_conflict')) throw error
      view = await readView(batchId, true)
      row = await write(view)
    }
    const info = headInfo(row)
    remember(view.project.id, key, info)
    return { kind: 'saved', head: snapshotOf(info) }
  } catch (error) {
    if (!isCode(error, 'annotation_head_conflict')) return { kind: 'failed', reason: reasonOf(error) }
    const current = await resolveHead(batchId, subject).catch(() => null)
    if (!current) return { kind: 'failed', reason: reasonOf(error) }
    remember(view.project.id, key, current)
    return { kind: 'conflict', head: snapshotOf(current) }
  }
}

/** What the server holds for this image now. */
async function resolveHead(batchId: number, subject: Subject): Promise<HeadInfo> {
  const view = await readView(batchId, true)
  const row = unwrap<HeadRow>(
    await api.POST('/api/annotations/projects/{project_id}/training-captions/head', {
      params: { path: { project_id: view.project.id } },
      body: { expected_project_revision: view.project.revision, subject },
    }),
  )
  return headInfo(row)
}

/** Save the user's caption as a new revision on top of `generation`. */
export function saveCaption(batchId: number, entry: Entry, content: CaptionContent, generation: number): Promise<SaveOutcome> {
  const subject = subjectOf(entry)
  if (!subject) return Promise.resolve({ kind: 'failed', reason: tr(lockedReason(entry) ?? 'dataset.edit.fileGone') })
  return writeHead(batchId, entry.key, subject, async (view) =>
    unwrap<HeadRow>(
      await api.POST('/api/annotations/projects/{project_id}/training-captions/revisions', {
        params: { path: { project_id: view.project.id } },
        body: { expected_project_revision: view.project.revision, expected_head_generation: generation, subject, content },
      }),
    ),
  )
}

/** Make an earlier revision the current one (appended as a new revision). */
export function restoreCaption(batchId: number, entry: Entry, revisionId: number, subjectId: number, generation: number): Promise<SaveOutcome> {
  const subject = subjectOf(entry)
  if (!subject) return Promise.resolve({ kind: 'failed', reason: tr(lockedReason(entry) ?? 'dataset.edit.fileGone') })
  return writeHead(batchId, entry.key, subject, async (view) =>
    unwrap<HeadRow>(
      await api.POST('/api/annotations/projects/{project_id}/subjects/{subject_id}/training-captions/restore', {
        params: { path: { project_id: view.project.id, subject_id: subjectId } },
        body: { expected_project_revision: view.project.revision, revision_id: revisionId, expected_head_generation: generation },
      }),
    ),
  )
}

export interface Revision {
  id: number
  source: string
  author_class: Author
  provider: string | null
  model: string | null
  restored_from_revision_id: number | null
  content: CaptionContent
  created_at: string
}

/** One image's caption history, newest first, a page at a time. */
export function useCaptionHistory(batch: Batch, view: BatchProjectView | undefined, subjectId: number | null, generation: number) {
  const library = useApp((s) => s.libraryId)
  return useInfiniteQuery({
    queryKey: ['caption-history', library, batch.id, subjectId, generation],
    enabled: !!view && subjectId !== null,
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam, signal }) =>
      unwrap<{ revisions: Revision[]; has_more: boolean; next_before_revision_id: number | null }>(
        await api.GET('/api/annotations/projects/{project_id}/subjects/{subject_id}/training-captions/revisions', {
          params: {
            path: { project_id: (view as BatchProjectView).project.id, subject_id: subjectId as number },
            query: { expected_project_revision: (view as BatchProjectView).project.revision, limit: 50, ...(pageParam ? { before_revision_id: pageParam } : {}) },
          },
          signal,
        }),
      ),
    getNextPageParam: (last) => (last.has_more ? last.next_before_revision_id : null),
    staleTime: 10_000,
  })
}

interface PreviewRow {
  image_id: number
  abs_path: string
  caption: string
  error: string | null
  skipped_reason: string | null
}

async function previewOne(body: unknown, signal?: AbortSignal): Promise<PreviewRow | null> {
  const res = unwrap<{ items: PreviewRow[] }>(await api.POST('/api/dataset/export-preview', { body: body as never, signal }))
  return res.items[0] ?? null
}

/** The batch rules switched off: what an image's own caption is rendered with. */
export function bareForm(form: DatasetForm): DatasetForm {
  const template = initialTemplate(form.template.trim() || DEFAULT_TEMPLATE, splitList(form.commonTags).length > 0)
  return { ...form, trigger: '', commonTags: '', blacklist: '', removeCategories: [], template }
}

async function storedText(imageId: number, signal?: AbortSignal): Promise<StoredText> {
  const detail = unwrap<{ image: StoredText }>(await api.GET('/api/images/{image_id}', { params: { path: { image_id: imageId } }, signal }))
  return { nl_caption: detail.image.nl_caption ?? null, ai_caption: detail.image.ai_caption ?? null }
}

async function renderInitial(form: DatasetForm, entry: Entry, signal?: AbortSignal): Promise<CaptionContent> {
  const [row, stored] = await Promise.all([
    previewOne(previewBody(bareForm(form), [entry], 1), signal),
    entry.imageId !== null ? storedText(entry.imageId, signal) : Promise.resolve(null),
  ])
  return initialContent(row?.caption ?? '', stored, form.template.trim() || DEFAULT_TEMPLATE)
}

const initialKey = (batchId: number, form: DatasetForm | null, entry: Entry | null) =>
  ['caption-initial', libraryId(), batchId, entry?.key, form ? JSON.stringify(bareForm(form)) : null] as const

/** The caption a never-edited image starts from (its tags and description, the batch rules off). */
export function useInitialContent(batch: Batch, form: DatasetForm | null, entry: Entry | null, needed: boolean) {
  useApp((s) => s.libraryId)
  return useQuery({
    queryKey: initialKey(batch.id, form, entry),
    enabled: needed && !!form && !!entry,
    queryFn: ({ signal }) => renderInitial(form as DatasetForm, entry as Entry, signal),
    staleTime: 60_000,
  })
}

/** The same, read fresh from the Library tags now (to start an edited caption over). */
export function fetchInitialContent(batchId: number, form: DatasetForm, entry: Entry): Promise<CaptionContent> {
  return queryClient.fetchQuery({ queryKey: initialKey(batchId, form, entry), queryFn: ({ signal }) => renderInitial(form, entry, signal), staleTime: 0 })
}

/** Where a preview row belongs among the entries. */
const rowKey = (imageId: number, path: string | null) => (imageId > 0 ? `id:${imageId}` : `path:${pathKey(path ?? '')}`)

/** The backend renders at most this many captions per preview. */
const CHUNK = 500

/**
 * Every image's caption as the template renders it (what a never-edited
 * image exports), by entry key: the list uses it to mark captions with
 * nothing of their own. Read again only when the settings or images change.
 */
export function useUneditedCaptions(batch: Batch, form: DatasetForm | null, entries: readonly Entry[]) {
  const library = useApp((s) => s.libraryId)
  const keys = entries.map((e) => e.key).join('|')
  return useQuery({
    queryKey: ['caption-unedited', library, batch.id, form ? JSON.stringify(form) : null, keys],
    enabled: !!form && entries.length > 0,
    queryFn: async ({ signal }) => {
      const byRow = new Map(entries.map((e) => [rowKey(e.imageId ?? 0, e.path), e.key]))
      const out = new Map<string, string>()
      for (let i = 0; i < entries.length; i += CHUNK) {
        const body = previewBody(form as DatasetForm, entries.slice(i, i + CHUNK), CHUNK)
        const res = unwrap<{ items: PreviewRow[] }>(await api.POST('/api/dataset/export-preview', { body: body as never, signal }))
        for (const row of res.items) {
          const key = byRow.get(rowKey(row.image_id, row.abs_path))
          if (key && !row.error && !row.skipped_reason) out.set(key, row.caption)
        }
      }
      return out
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

export interface FinalCaption {
  caption: string
  problem: string | null
}

/**
 * The caption the export writes for this image now: its revision (or the
 * template) under the batch rules. Asked only once the heads are known: the
 * backend refuses "no revision" for an image that has one.
 */
export function useFinalCaption(
  batch: Batch,
  view: BatchProjectView | undefined,
  form: DatasetForm | null,
  entry: Entry | null,
  head: HeadSnapshot,
  headsKnown: boolean,
) {
  const library = useApp((s) => s.libraryId)
  const scope =
    view && entry && entry.status !== 'changed'
      ? { projectId: view.project.id, projectRevision: view.project.revision, heads: new Map([[entry.key, { revisionId: head.revisionId ?? undefined }]]) }
      : null
  const body = form && entry ? JSON.stringify(previewBody(form, [entry], 1, scope)) : null
  return useQuery({
    queryKey: ['caption-final', library, batch.id, body],
    enabled: headsKnown && body !== null && (entry?.imageId !== null || entry?.status !== 'missing'),
    queryFn: async ({ signal }): Promise<FinalCaption> => {
      const row = await previewOne(JSON.parse(body as string), signal)
      return { caption: row?.caption ?? '', problem: row ? (row.error ?? row.skipped_reason) : null }
    },
    staleTime: 30_000,
  })
}
