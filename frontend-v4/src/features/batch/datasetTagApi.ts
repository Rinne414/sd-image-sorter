import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import { api, ApiError, unwrap } from '../../api/client'
import { fetchModelStatus } from '../../api/queries'
import { queryClient } from '../../api/queryClient'
import type { Batch, BatchProjectView } from '../../api/types'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { installAllThen, type InstallTarget } from '../jobs/installJob'
import { isQueueBusy, tr } from '../jobs/jobs'
import { readiness, taggerInfo, type ModelCard, type TaggerInfo } from '../tagging/taggers'
import { projectKey } from './datasetApi'
import { folderKey, libraryKey } from './datasetItems'
import { formFromSettings, readBatchDataset, type Purpose, type TargetModel } from './datasetSettings'
import {
  headKey,
  resultContent,
  resultSource,
  revisionsFromResults,
  smartTagBody,
  type Author,
  type CaptionContent,
  type HeadInfo,
  type SmartTagResult,
  type TagScope,
  type TagStepOptions,
} from './datasetTag'
import { entriesFromProject, type Entry } from './entries'
import { renderInitialContents } from './edit/initialContents'
import { trackSmartTagJob } from './trackSmartTag'
import { forgetRun, pendingRun, rememberRun, resumeRun } from './tagRunResume'

// A dataset batch's tag step talks to Smart Tag. Library images get their
// tags and descriptions in the Library, as V3.5 does; the batch writes the
// folder images' results as caption revisions marked as AI output.

const libraryId = () => useApp.getState().libraryId

function toast(text: string, tone: 'info' | 'error' = 'info'): void {
  useToasts.getState().push(text, tone)
}

/** The VLM set up in V3.5 (read only here; it is set up in V3.5's VLM settings). */
export interface VlmStatus {
  configured: boolean
  /** Runs on this computer (loopback), so calls cost nothing. */
  local: boolean
  label: string
}

function isLoopback(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.local')
  } catch {
    return false
  }
}

export function useVlmStatus() {
  return useQuery({
    queryKey: ['vlm-settings'],
    queryFn: async ({ signal }): Promise<VlmStatus> => {
      const s = unwrap<Record<string, unknown>>(await api.GET('/api/vlm/settings', { signal }))
      const endpoint = typeof s.endpoint === 'string' ? s.endpoint.trim() : ''
      const vertex = s.use_vertex === true && typeof s.vertex_project === 'string' && s.vertex_project.trim() !== ''
      const model = typeof s.model === 'string' ? s.model.trim() : ''
      const provider = typeof s.provider === 'string' ? s.provider : ''
      return { configured: endpoint !== '' || vertex, local: endpoint !== '' && isLoopback(endpoint), label: model || provider }
    },
    staleTime: 60_000,
  })
}

export interface HeadRow {
  item: { item_type: 'library'; image_id: number } | { item_type: 'local'; path: string }
  subject_id: number | null
  generation: number
  active_revision: { id: number; author_class: Author; content: CaptionContent } | null
}

/** A head row as the steps keep it (who wrote it, its revision and content). */
export function headInfo(row: HeadRow): HeadInfo {
  const active = row.active_revision
  return {
    generation: row.generation,
    author: active?.author_class ?? null,
    ...(active ? { revisionId: active.id, content: active.content } : {}),
    ...(row.subject_id !== null ? { subjectId: row.subject_id } : {}),
  }
}

export async function fetchHeads(view: BatchProjectView, signal?: AbortSignal): Promise<Map<string, HeadInfo>> {
  const heads = new Map<string, HeadInfo>()
  let after: number | undefined
  for (;;) {
    const page = unwrap<{ items: HeadRow[]; has_more: boolean; next_after_subject_id: number | null }>(
      await api.GET('/api/annotations/projects/{project_id}/training-captions/heads', {
        params: {
          path: { project_id: view.project.id },
          query: { expected_project_revision: view.project.revision, limit: 200, ...(after ? { after_subject_id: after } : {}) },
        },
        signal,
      }),
    )
    for (const row of page.items) {
      if (row.generation > 0) heads.set(headKey(row.item), headInfo(row))
    }
    if (!page.has_more || page.next_after_subject_id === null) return heads
    after = page.next_after_subject_id
  }
}

/** The caption revisions the project's images have (who wrote each). */
export function useProjectHeads(view: BatchProjectView | undefined) {
  const library = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: headsKey(library, view?.project.id, view?.project.revision),
    enabled: !!view,
    queryFn: ({ signal }) => fetchHeads(view as BatchProjectView, signal),
    // A new project revision (a settings save) reads them again; the same project's old map stays meanwhile.
    placeholderData: (previous, query) => (query?.queryKey[2] === view?.project.id ? previous : undefined),
    staleTime: 15_000,
  })
}

export const headsKey = (library: string, projectId?: number, revision?: number) => ['batch-heads', library, projectId, revision] as const

/** Describer models that run on this computer, as model cards. */
const DESCRIBER_CARDS: Record<'florence2' | 'toriigate', TaggerInfo & { sizeHint: string }> = {
  florence2: { card: 'florence2', variant: null, label: 'Florence-2', note: 'tagger.note.custom', sizeHint: '465 MB' },
  toriigate: { card: 'toriigate', variant: null, label: 'ToriiGate', note: 'tagger.note.custom', sizeHint: '9.6 GB' },
}

export const describerCard = (d: 'florence2' | 'toriigate') => DESCRIBER_CARDS[d]

/** Models this run needs that are not on disk yet (downloaded first, one at a time), and one that needs a restart. */
async function modelsToPrepare(o: TagStepOptions): Promise<{ install: InstallTarget[]; restart: TaggerInfo | null }> {
  let cards: ModelCard[] | undefined
  try {
    cards = (await queryClient.fetchQuery({ queryKey: ['model-status'], queryFn: () => fetchModelStatus(), staleTime: 0 })).models
  } catch {
    cards = undefined
  }
  const infos = [o.model, o.secondModel].filter((m): m is string => !!m).map(taggerInfo)
  if (o.describer === 'florence2' || o.describer === 'toriigate') infos.push(DESCRIBER_CARDS[o.describer])
  const state = infos.map((info) => [info, readiness(info, cards)] as const)
  return {
    install: state.filter(([, r]) => r === 'download' || r === 'check').map(([info]) => info),
    restart: state.find(([, r]) => r === 'restart')?.[0] ?? null,
  }
}

export interface TagRun {
  jobId: string | null
  /** Entry keys this run was sent. */
  ranKeys: string[]
  /** The run ended well and its results are written. */
  finished: boolean
  /** Folder results written as caption revisions. */
  written: number
  /** Folder images whose caption the user edited: kept, with their new results. */
  keptResults: SmartTagResult[]
  /** Caption writes that failed. */
  failed: number
  writing: boolean
}

/** The last tag run of each batch, for the step to report on. */
export const useTagRuns = create<{ runs: Record<number, TagRun> }>(() => ({ runs: {} }))

function setRun(batchId: number, patch: Partial<TagRun>): void {
  useTagRuns.setState((s) => {
    const old = s.runs[batchId] ?? { jobId: null, ranKeys: [], finished: false, written: 0, keptResults: [], failed: 0, writing: false }
    return { runs: { ...s.runs, [batchId]: { ...old, ...patch } } }
  })
}

function refreshBatch(batchId: number): void {
  for (const key of [projectKey(libraryId(), batchId), ['batch-heads'], ['dataset-preview'], ['images'], ['image']]) {
    void queryClient.invalidateQueries({ queryKey: key })
  }
}

async function allResults(jobId: string): Promise<SmartTagResult[]> {
  const rows: SmartTagResult[] = []
  for (let offset = 0; ; ) {
    const page = unwrap<{ results: SmartTagResult[]; has_more: boolean; limit: number }>(
      await api.GET('/api/smart-tag/results', { params: { query: { job_id: jobId, offset, limit: 1000 } } }),
    )
    rows.push(...page.results)
    if (!page.has_more) return rows
    offset += page.limit
  }
}

type Subject = { item_type: 'library'; image_id: number } | { item_type: 'local'; path: string }

/** One caption revision marked as AI output; false when it could not be written. */
async function writeAiRevision(
  view: BatchProjectView,
  subject: Subject,
  content: CaptionContent,
  source: 'wd14' | 'vlm',
  generation: number,
  model: string,
): Promise<boolean> {
  try {
    unwrap(
      await api.POST('/api/annotations/projects/{project_id}/training-captions/revisions', {
        params: { path: { project_id: view.project.id } },
        body: {
          expected_project_revision: view.project.revision,
          expected_head_generation: generation,
          subject,
          content,
          ai_provenance: { source, model: model || null },
        },
      }),
    )
    return true
  } catch {
    return false
  }
}

const readView = (batchId: number) =>
  queryClient.fetchQuery({
    queryKey: projectKey(libraryId(), batchId),
    queryFn: async () => unwrap<BatchProjectView>(await api.GET('/api/batches/{batch_id}/project', { params: { path: { batch_id: batchId } } })),
    staleTime: 0,
  })

/**
 * Fresh captions (by entry key) for Library images, as the caption editor
 * starts them: tags in the tag box, the stored description in the words box.
 */
async function freshLibraryContents(batch: Batch, view: BatchProjectView, entries: readonly Entry[]): Promise<Map<string, CaptionContent>> {
  const form = formFromSettings(view.project.settings, readBatchDataset(batch.settings))
  return renderInitialContents(form, entries)
}

/**
 * Library images whose caption revision the AI wrote follow their Library
 * tags: after the tags change (a run, new thresholds) each gets a new
 * revision from them. A user's edit is never touched. Returns failed writes.
 */
async function refreshAiLibraryCaptions(batch: Batch, view: BatchProjectView, heads: ReadonlyMap<string, HeadInfo>, model: string): Promise<number> {
  const stale = entriesFromProject(view).filter((e) => e.imageId !== null && heads.get(e.key)?.author === 'ai')
  if (stale.length === 0) return 0
  const fresh = await freshLibraryContents(batch, view, stale)
  let failed = 0
  for (const entry of stale) {
    const id = entry.imageId as number
    const content = fresh.get(entry.key)
    if (!content?.booru_caption) continue
    const ok = await writeAiRevision(view, { item_type: 'library', image_id: id }, content, 'wd14', heads.get(entry.key)?.generation ?? 0, model)
    if (!ok) failed += 1
  }
  return failed
}

/** After the Library tags changed outside a run (new thresholds): AI captions follow them. */
export async function syncAiCaptions(batch: Batch, model: string): Promise<void> {
  try {
    const view = await readView(batch.id)
    const failed = await refreshAiLibraryCaptions(batch, view, await fetchHeads(view), model)
    if (failed) toast(tr('dataset.tag.writeFailed', { n: failed }), 'error')
  } catch (error) {
    toast(tr('error.generic', { reason: (error as Error).message }), 'error')
  } finally {
    refreshBatch(batch.id)
  }
}

/** After a run: the folder images' results become AI caption revisions; a user's edit stays. */
async function applyResults(batch: Batch, jobId: string, model: string): Promise<void> {
  setRun(batch.id, { jobId, writing: true })
  try {
    const view = await readView(batch.id)
    const [rows, heads] = await Promise.all([allResults(jobId), fetchHeads(view)])
    const plan = revisionsFromResults(rows, heads)
    let written = 0
    let failed = 0
    for (const r of plan.write) {
      if (await writeAiRevision(view, { item_type: 'local', path: r.path }, r.content, r.source, r.generation, model)) written += 1
      else failed += 1
    }
    failed += await refreshAiLibraryCaptions(batch, view, heads, model)
    const kept = new Set(plan.kept)
    setRun(batch.id, { written, failed, keptResults: rows.filter((row) => kept.has(row.path)), writing: false, finished: true })
    if (failed) toast(tr('dataset.tag.writeFailed', { n: failed }), 'error')
  } catch (error) {
    setRun(batch.id, { writing: false })
    toast(tr('error.generic', { reason: (error as Error).message }), 'error')
  } finally {
    forgetRun(jobId)
    refreshBatch(batch.id)
  }
}

/** A run started before a reload: report on it here and write its results when it ends. */
export async function resumeTagRun(batch: Batch): Promise<void> {
  const run = pendingRun(batch.id)
  if (!run || useTagRuns.getState().runs[batch.id]) return
  setRun(batch.id, { jobId: run.jobId, ranKeys: run.ranKeys })
  await resumeRun(run, (r) => applyResults(batch, r.jobId, r.model))
}

async function startRun(batch: Batch, body: ReturnType<typeof smartTagBody>, count: number, model: string): Promise<boolean> {
  try {
    const res = unwrap<{ job_id?: string; queue_id?: string; status?: string }>(await api.POST('/api/smart-tag/start', { body: body as never }))
    const ranKeys = [...body.image_ids.map(libraryKey), ...body.image_paths.map(folderKey)]
    setRun(batch.id, { jobId: res.job_id ?? null, ranKeys, finished: false, written: 0, keptResults: [], failed: 0, writing: false })
    if (res.job_id) rememberRun({ batchId: batch.id, jobId: res.job_id, model, ranKeys })
    trackSmartTagJob({
      count,
      jobId: res.job_id ?? null,
      queueId: res.queue_id ?? null,
      queued: res.status === 'queued',
      then: (jobId) => applyResults(batch, jobId, model),
    })
    return true
  } catch (error) {
    const busy = error instanceof ApiError && error.status === 409
    toast(busy ? tr('jobs.busy') : tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  }
}

/** Start the tag step: download what is missing first, then run Smart Tag on the scope. */
export async function startDatasetTagging(
  batch: Batch,
  o: TagStepOptions,
  scope: TagScope,
  purpose: Purpose | null,
  targetModel: TargetModel,
): Promise<boolean> {
  if (isQueueBusy('smarttag')) {
    toast(tr('jobs.busy'), 'error')
    return false
  }
  const body = smartTagBody(o, scope, purpose, targetModel)
  const count = scope.ids.length + scope.paths.length
  const { install, restart } = await modelsToPrepare(o)
  if (restart) {
    toast(tr('tagging.needsRestart', { name: restart.label }), 'error')
    return false
  }
  if (install.length === 0) return startRun(batch, body, count, o.model)
  return installAllThen(install, () => void startRun(batch, body, count, o.model))
}

/**
 * Replace the user's own captions with the new tags: Library images start
 * again from their Library tags, folder images take the last run's results.
 * Each becomes a new revision (the user's version stays in the history).
 */
export async function replaceEditedCaptions(batch: Batch, entries: readonly Entry[], keys: readonly string[], model: string): Promise<boolean> {
  try {
    const view = await readView(batch.id)
    const heads = await fetchHeads(view)
    const wanted = new Set(keys)
    const chosen = entries.filter((e) => wanted.has(e.key))
    const library = chosen.filter((e) => e.imageId !== null)
    const fresh = library.length ? await freshLibraryContents(batch, view, library) : new Map<string, CaptionContent>()
    const kept = new Map((useTagRuns.getState().runs[batch.id]?.keptResults ?? []).map((row) => [headKey({ item_type: 'local', path: row.path }), row]))
    let failed = 0
    let written = 0
    for (const entry of chosen) {
      const row = entry.imageId === null ? kept.get(entry.key) : undefined
      const content = entry.imageId !== null ? fresh.get(entry.key) : row ? resultContent(row) : undefined
      if (!content || (!content.booru_caption && !content.nl_caption)) continue
      const subject: Subject = entry.imageId !== null ? { item_type: 'library', image_id: entry.imageId } : { item_type: 'local', path: entry.path ?? '' }
      const generation = heads.get(entry.key)?.generation ?? 0
      if (await writeAiRevision(view, subject, content, row ? resultSource(row) : 'wd14', generation, model)) written += 1
      else failed += 1
    }
    setRun(batch.id, { keptResults: [] })
    if (failed) toast(tr('dataset.tag.writeFailed', { n: failed }), 'error')
    else toast(tr('dataset.tag.replaced', { n: written }))
    return failed === 0
  } catch (error) {
    toast(tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  } finally {
    refreshBatch(batch.id)
  }
}

export interface ScoreStats {
  floor: number
  models: { model: string; rows: number; images: number }[]
}

export function useScoreStats() {
  return useQuery({
    queryKey: ['tag-score-stats'],
    queryFn: async ({ signal }) => unwrap<ScoreStats>(await api.GET('/api/tags/scores/stats', { signal })),
    staleTime: 30_000,
  })
}

export interface RethresholdReport {
  with_scores: number
  skipped_no_scores: number
  images_changed: number
  tags_added: number
  tags_removed: number
  applied: boolean
}

/** The filters a tag run applies when it writes, so new thresholds honour them too. */
export interface WriteFilters {
  blacklist: string[]
  maxTags: number
}

/** Re-apply thresholds from the stored scores (no tagging): a dry run tells what would change. */
export async function rethreshold(
  ids: readonly number[],
  model: string,
  threshold: number,
  dryRun: boolean,
  filters: WriteFilters,
): Promise<RethresholdReport> {
  return unwrap<RethresholdReport>(
    await api.POST('/api/tags/rethreshold', {
      body: {
        image_ids: [...ids],
        model,
        threshold,
        consensus_min: 2,
        dry_run: dryRun,
        pre_tag_blacklist: filters.blacklist,
        max_tags_per_image: filters.maxTags,
      },
    }),
  )
}
