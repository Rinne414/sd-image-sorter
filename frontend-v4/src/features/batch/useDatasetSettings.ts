import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, unwrap } from '../../api/client'
import type { Batch, BatchProjectView } from '../../api/types'
import { useApp } from '../../state/store'
import { patchBatch } from './batchApi'
import { previewBody, type TemplatePreset } from './captionRules'
import { saveProjectSettings, useBatchProject } from './datasetApi'
import {
  batchDatasetFromForm,
  formFromSettings,
  readBatchDataset,
  settingsFromForm,
  triggerProblem,
  withTriggerChange,
  writeBatchDataset,
  type DatasetForm,
} from './datasetSettings'
import { pathKey } from './datasetItems'
import { useProjectHeads } from './datasetTagApi'
import { entriesFromProject, type Entry } from './entries'

/** Quiet time after the last edit before the settings are saved. */
const SAVE_AFTER_MS = 700
/** Quiet time before the preview asks again while typing. */
const PREVIEW_AFTER_MS = 250
/** The backend renders at most this many preview captions. */
export const PREVIEW_LIMIT = 500

export type SaveState = 'saved' | 'waiting' | 'saving' | 'failed'

const previewKey = (imageId: number, path: string | null) => (imageId > 0 ? `id:${imageId}` : `path:${pathKey(path ?? '')}`)

/** Preview rows in the batch's order (the backend lists Library images before folder images). */
function inBatchOrder(items: readonly PreviewItem[], entries: readonly Entry[]): PreviewItem[] {
  const rank = new Map(entries.map((e, i) => [previewKey(e.imageId ?? 0, e.path), i]))
  const at = (item: PreviewItem) => rank.get(previewKey(item.image_id, item.abs_path)) ?? entries.length
  return [...items].sort((a, b) => at(a) - at(b))
}

export interface PreviewItem {
  image_id: number
  abs_path: string
  filename: string
  thumbnail_url: string
  caption: string
  error: string | null
  skipped_reason: string | null
}

/** Template presets (GET /api/tags/export-presets): each base model's default template. */
export function useTemplatePresets() {
  return useQuery({
    queryKey: ['export-presets'],
    queryFn: async ({ signal }) =>
      unwrap<{ presets: TemplatePreset[]; variables: { name: string }[] }>(await api.GET('/api/tags/export-presets', { signal })),
    staleTime: Infinity,
  })
}

function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setOut(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return out
}

/** Save the form: V1 settings into the project, purpose and categories into the batch row. */
async function saveForm(batch: Batch, view: BatchProjectView, form: DatasetForm): Promise<boolean> {
  const saved = view.project.settings
  const next = settingsFromForm(form, saved)
  let ok = true
  if (JSON.stringify(next) !== JSON.stringify(saved)) {
    ok = await saveProjectSettings(batch.id, (current) => settingsFromForm(form, current))
  }
  const own = batchDatasetFromForm(form)
  if (ok && JSON.stringify(own) !== JSON.stringify(readBatchDataset(batch.settings))) {
    ok = (await patchBatch(batch.id, { settings: writeBatchDataset(batch.settings, own) }, batch.revision)) !== null
  }
  return ok
}

/**
 * The dataset batch's settings as the strip edits them. Edits apply to the
 * preview at once and are saved after a short pause; the trigger is typed
 * apart and only counts once it is finished (blur or Enter), so a half-typed
 * trigger never lands on the blacklist as an "old" one. The preview (the
 * first PREVIEW_LIMIT images, edited ones as their saved revision) is only
 * asked for while `previewOn`.
 */
export function useDatasetSettings(batch: Batch, previewOn = true) {
  const project = useBatchProject(batch)
  const view = project.data
  const heads = useProjectHeads(previewOn ? view : undefined)
  const saved = useMemo(() => (view ? formFromSettings(view.project.settings, readBatchDataset(batch.settings)) : null), [view, batch.settings])
  const [draft, setDraft] = useState<DatasetForm | null>(null)
  const [triggerText, setTriggerText] = useState<string | null>(null)
  const [state, setState] = useState<SaveState>('saved')
  const form = draft ?? saved
  const latest = useRef({ draft, view, batch })
  latest.current = { draft, view, batch }

  const edit = useCallback((change: (form: DatasetForm) => DatasetForm) => {
    setDraft((d) => {
      const { view: v, batch: b } = latest.current
      const base = d ?? (v ? formFromSettings(v.project.settings, readBatchDataset(b.settings)) : null)
      return base ? change(base) : d
    })
    setState('waiting')
  }, [])

  const flush = useCallback(async () => {
    const { draft: pending, view: current, batch: b } = latest.current
    if (!pending || !current) return
    setState('saving')
    const ok = await saveForm(b, current, pending)
    // Edits made while saving stay as a draft (and save next); a failure drops them: the saved values are read again.
    setDraft((d) => (d === pending || !ok ? null : d))
    setState(ok ? 'saved' : 'failed')
  }, [])

  useEffect(() => {
    if (!draft) return
    const timer = setTimeout(() => void flush(), SAVE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [draft, flush])

  // Leaving the batch saves what is still waiting.
  useEffect(() => () => void flush(), [flush])

  const savedTrigger = view?.project.settings.caption_render.trigger ?? ''
  const typing = triggerText !== null && triggerProblem(triggerText) === null ? triggerText.trim() : null
  const commitTrigger = () => {
    if (triggerText === null || triggerProblem(triggerText) !== null) return
    const text = triggerText
    setTriggerText(null)
    if (text.trim() !== (form?.trigger ?? '')) edit((f) => withTriggerChange({ ...f, trigger: text.trim() }, savedTrigger))
  }

  // The preview shows the form as it is on screen, the trigger being typed included.
  const shown = form ? (typing !== null ? withTriggerChange({ ...form, trigger: typing }, savedTrigger) : form) : null
  const entries = useMemo(() => (view ? entriesFromProject(view) : []), [view])
  // Edited images preview as their revision; until the heads are read nothing is asked (a failed read previews the template).
  const scope = view && heads.data ? { projectId: view.project.id, projectRevision: view.project.revision, heads: heads.data } : null
  const ready = previewOn && (scope !== null || heads.isError)
  const body = useDebounced(ready && shown ? JSON.stringify(previewBody(shown, entries.slice(0, PREVIEW_LIMIT), PREVIEW_LIMIT, scope)) : null, PREVIEW_AFTER_MS)
  const library = useApp((s) => s.libraryId)
  const preview = useQuery({
    queryKey: ['dataset-preview', library, batch.id, body],
    enabled: body !== null,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) =>
      unwrap<{ total: number; returned: number; items: PreviewItem[] }>(
        await api.POST('/api/dataset/export-preview', { body: JSON.parse(body as string), signal }),
      ),
  })
  const items = useMemo(() => (preview.data ? inBatchOrder(preview.data.items, entries) : null), [preview.data, entries])

  return {
    loading: !view && !project.isError,
    error: project.isError ? project.error.message : null,
    form,
    shown,
    edit,
    flush,
    state,
    triggerText: triggerText ?? form?.trigger ?? '',
    setTriggerText,
    commitTrigger,
    triggerIssue: triggerText === null ? null : triggerProblem(triggerText),
    savedTrigger,
    preview,
    items,
    total: entries.length,
  }
}
