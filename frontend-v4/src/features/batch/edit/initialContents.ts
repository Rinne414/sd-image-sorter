import { api, unwrap } from '../../../api/client'
import { DEFAULT_TEMPLATE, previewBody } from '../captionRules'
import { splitList, type DatasetForm } from '../datasetSettings'
import type { CaptionContent } from '../datasetTag'
import type { Entry } from '../entries'
import { contentsFromRows, initialTemplate, type PreviewRow } from './captionContent'

// The caption an image starts from before anyone edited it: what the caption
// editor shows first, what a bulk change starts from, and what the tag step
// writes when AI captions follow new Library tags. One builder for all three,
// so tags land in the tag box and descriptions in the description box.

/** The backend renders at most this many captions per preview. */
export const PREVIEW_CHUNK = 500

/** The batch rules switched off: what an image's own caption is rendered with. */
export function bareForm(form: DatasetForm): DatasetForm {
  const template = initialTemplate(form.template.trim() || DEFAULT_TEMPLATE, splitList(form.commonTags).length > 0)
  return { ...form, trigger: '', commonTags: '', blacklist: '', removeCategories: [], template }
}

async function preview(body: unknown, signal?: AbortSignal): Promise<PreviewRow[]> {
  return unwrap<{ items: PreviewRow[] }>(await api.POST('/api/dataset/export-preview', { body: body as never, signal })).items
}

/**
 * Fresh captions for these images, by entry key: the tags rendered with the
 * batch's template (rules off, words left out) and the stored description,
 * each render asked for in chunks the backend accepts.
 */
export async function renderInitialContents(form: DatasetForm, entries: readonly Entry[], signal?: AbortSignal): Promise<Map<string, CaptionContent>> {
  const bare = bareForm(form)
  const template = form.template.trim() || DEFAULT_TEMPLATE
  const out = new Map<string, CaptionContent>()
  for (let i = 0; i < entries.length; i += PREVIEW_CHUNK) {
    const chunk = entries.slice(i, i + PREVIEW_CHUNK)
    const tagsBody = previewBody(bare, chunk, chunk.length)
    const wordsBody = { ...previewBody({ ...bare, prefix: '' }, chunk, chunk.length), content_mode: 'nl_caption' }
    const [tags, words] = await Promise.all([preview(tagsBody, signal), preview(wordsBody, signal)])
    for (const [key, content] of contentsFromRows(chunk, tags, words, template)) out.set(key, content)
  }
  return out
}
