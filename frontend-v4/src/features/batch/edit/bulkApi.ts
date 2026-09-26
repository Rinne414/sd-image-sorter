import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { create } from 'zustand'
import { api, ApiError, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { Batch, BatchProjectView } from '../../../api/types'
import { useApp } from '../../../state/store'
import { projectKey } from '../datasetApi'
import type { DatasetForm } from '../datasetSettings'
import type { Author, CaptionContent, HeadInfo } from '../datasetTag'
import { headsKey } from '../datasetTagApi'
import type { Entry } from '../entries'
import { subjectOf } from './captionApi'
import type { Change } from './captionOps'
import { bareForm, renderInitialContents } from './initialContents'

// Bulk caption changes: every changed caption becomes a new revision, written
// in as few requests as possible (the backend takes up to 5,000 per request,
// all or nothing). An undo writes each image's earlier revision back as a
// restore; an image that had none gets its earlier caption back as a revision.

/** Captions per request (the backend's batch size; larger changes take several requests). */
export const WRITE_CHUNK = 5000

const libraryId = () => useApp.getState().libraryId

/** Every image's caption as a bulk change starts from: its revision, or (never edited) the one it would start from. */
export function useBatchContents(batch: Batch, form: DatasetForm | null, entries: readonly Entry[], heads: ReadonlyMap<string, HeadInfo> | undefined, on: boolean) {
  const library = useApp((s) => s.libraryId)
  const unedited = heads ? entries.filter((e) => !heads.get(e.key)?.content && subjectOf(e) !== null) : []
  const initial = useQuery({
    queryKey: ['caption-initial-all', library, batch.id, form ? JSON.stringify(bareForm(form)) : null, unedited.map((e) => e.key).join('|')],
    enabled: on && !!form && !!heads && unedited.length > 0,
    queryFn: ({ signal }) => renderInitialContents(form as DatasetForm, unedited, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
  const contents = useMemo(() => {
    const out = new Map<string, CaptionContent>()
    for (const entry of entries) {
      const content = heads?.get(entry.key)?.content ?? initial.data?.get(entry.key)
      if (content && subjectOf(entry) !== null) out.set(entry.key, content)
    }
    return out
  }, [entries, heads, initial.data])
  const ready = !!heads && (unedited.length === 0 || initial.data !== undefined)
  return { contents, ready, loading: on && !ready && !initial.isError, error: initial.isError ? initial.error.message : null }
}

interface BatchItem {
  subject_id: number
  generation: number
  revision_id: number
  author_class: Author
}

type Entries = {
  subject: NonNullable<ReturnType<typeof subjectOf>>
  expected_head_generation: number
  content?: CaptionContent
  restore_revision_id?: number
  template_snapshot?: boolean
}[]

async function readView(batchId: number, fresh: boolean): Promise<BatchProjectView> {
  const key = projectKey(libraryId(), batchId)
  const cached = fresh ? undefined : queryClient.getQueryData<BatchProjectView>(key)
  if (cached) return cached
  return queryClient.fetchQuery({
    queryKey: key,
    queryFn: async () => unwrap<BatchProjectView>(await api.GET('/api/batches/{batch_id}/project', { params: { path: { batch_id: batchId } } })),
    staleTime: 0,
  })
}

async function post(view: BatchProjectView, entries: Entries): Promise<BatchItem[]> {
  return unwrap<{ items: BatchItem[] }>(
    await api.POST('/api/annotations/projects/{project_id}/training-captions/revisions:batch', {
      params: { path: { project_id: view.project.id } },
      body: { expected_project_revision: view.project.revision, entries: entries as never },
    }),
  ).items
}

/** One request; the project read again once if its revision moved (a settings save). */
async function postChunk(batchId: number, entries: Entries): Promise<{ view: BatchProjectView; items: BatchItem[] }> {
  const view = await readView(batchId, false)
  try {
    return { view, items: await post(view, entries) }
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'annotation_project_revision_conflict')) throw error
    const fresh = await readView(batchId, true)
    return { view: fresh, items: await post(fresh, entries) }
  }
}

/** Keep the new heads in every cached copy of this project's heads. */
function remember(projectId: number, next: ReadonlyMap<string, HeadInfo>): void {
  queryClient.setQueriesData<Map<string, HeadInfo>>({ queryKey: headsKey(libraryId(), projectId).slice(0, 3) }, (old) => {
    if (!old) return old
    const out = new Map(old)
    for (const [key, info] of next) out.set(key, info)
    return out
  })
}

/** What one image had before a bulk change and what it has after (what an undo needs). */
export interface Written {
  key: string
  before: HeadInfo | undefined
  beforeContent: CaptionContent
  after: HeadInfo
}

export interface WriteOutcome {
  written: Written[]
  /** Images a refused request named: changed elsewhere, gone, or their file changed. */
  refused: number
  error: string | null
}

interface Step {
  key: string
  entry: Entry
  expected: number
  content: CaptionContent
  restore: number | null
  /** The content is the template's for a never-edited image (an undo): kept as a system snapshot. */
  snapshot: boolean
  before: HeadInfo | undefined
  beforeContent: CaptionContent
}

function refusal(error: unknown): { refused: number; message: string } {
  if (error instanceof ApiError && error.code === 'annotation_batch_conflict') {
    const problems = (error.body as { problems?: unknown[] } | null)?.problems ?? []
    return { refused: problems.length, message: error.message }
  }
  return { refused: 0, message: (error as Error).message }
}

/** Write the steps a chunk at a time; stops at the first refused request (its images are left as they were). */
async function writeSteps(batchId: number, steps: readonly Step[]): Promise<WriteOutcome> {
  const written: Written[] = []
  for (let i = 0; i < steps.length; i += WRITE_CHUNK) {
    const chunk = steps.slice(i, i + WRITE_CHUNK)
    const entries: Entries = chunk.map((s) => ({
      subject: subjectOf(s.entry) as NonNullable<ReturnType<typeof subjectOf>>,
      expected_head_generation: s.expected,
      ...(s.restore !== null ? { restore_revision_id: s.restore } : { content: s.content, ...(s.snapshot ? { template_snapshot: true } : {}) }),
    }))
    try {
      const { view, items } = await postChunk(batchId, entries)
      const next = new Map<string, HeadInfo>()
      chunk.forEach((s, n) => {
        const item = items[n] as BatchItem
        const after: HeadInfo = { generation: item.generation, author: item.author_class, revisionId: item.revision_id, subjectId: item.subject_id, content: s.content }
        next.set(s.key, after)
        written.push({ key: s.key, before: s.before, beforeContent: s.beforeContent, after })
      })
      remember(view.project.id, next)
    } catch (error) {
      const { refused, message } = refusal(error)
      void queryClient.invalidateQueries({ queryKey: ['batch-heads'] })
      return { written, refused, error: message }
    }
  }
  return { written, refused: 0, error: null }
}

/** Write a bulk change's captions as new revisions. */
export function writeChanges(
  batchId: number,
  changes: readonly Change[],
  entries: ReadonlyMap<string, Entry>,
  heads: ReadonlyMap<string, HeadInfo>,
): Promise<WriteOutcome> {
  const steps: Step[] = []
  for (const change of changes) {
    const entry = entries.get(change.key)
    if (!entry || subjectOf(entry) === null) continue
    const before = heads.get(change.key)
    steps.push({ key: change.key, entry, expected: before?.generation ?? 0, content: change.after, restore: null, snapshot: false, before, beforeContent: change.before })
  }
  return writeSteps(batchId, steps)
}

/**
 * Put every image a bulk change wrote back the way it was: its earlier
 * revision restored (by whoever wrote it), or, for an image nobody had
 * edited, the template's caption kept as a system snapshot (not as the
 * user's writing).
 */
export function undoWritten(batchId: number, written: readonly Written[], entries: ReadonlyMap<string, Entry>): Promise<WriteOutcome> {
  const steps: Step[] = []
  for (const w of written) {
    const entry = entries.get(w.key)
    if (!entry || subjectOf(entry) === null) continue
    const restore = w.before?.revisionId ?? null
    steps.push({
      key: w.key,
      entry,
      expected: w.after.generation,
      content: w.beforeContent,
      restore,
      snapshot: restore === null,
      before: w.after,
      beforeContent: w.after.content as CaptionContent,
    })
  }
  return writeSteps(batchId, steps)
}

/** The last bulk change of each batch, for its undo button. */
export interface LastBulk {
  label: string
  written: Written[]
  /** Set once it has been undone (from the toast or the panel), so it is undone once. */
  undone: boolean
}

export const useLastBulk = create<{ last: Record<number, LastBulk | null> }>(() => ({ last: {} }))

export const setLastBulk = (batchId: number, value: LastBulk | null) => useLastBulk.setState((s) => ({ last: { ...s.last, [batchId]: value } }))

export interface Gap {
  image_id: number
  filename: string
  score: number
}

/** Library images whose stored score for the tag sits just under the tagger's threshold, without the tag. */
export async function coverageGaps(tag: string, imageIds: readonly number[]): Promise<Gap[]> {
  const res = unwrap<{ gaps: Gap[] }>(
    await api.POST('/api/tags/coverage-gaps', { body: { tag: tag.trim().replace(/ /g, '_'), image_ids: [...imageIds], limit: 2000 } }),
  )
  return res.gaps
}
