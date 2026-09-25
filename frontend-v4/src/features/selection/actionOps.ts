import { useMemo } from 'react'
import { useCategories, useFavorites, useImageDetail, useSetRating, useToggleFavorite } from '../../api/queries'
import type { ImageDetailResponse } from '../../api/types'
import { readGeneration, toParameterText } from '../../lib/meta'
import { segmentPrompt, tagKey } from '../../lib/prompt'
import { groupTags } from '../../lib/tagGroups'
import { useApp } from '../../state/store'
import { addPicksTo, recentBatches } from '../batch/AddToBatchMenu'
import { useBatches, useBatchTemplates } from '../batch/batchApi'
import { askNewBatch } from '../batch/dialogStore'
import { quickCensor } from '../censor/quickCensor'
import { copyAndSay, openImageFolder } from '../library/fileActions'
import { bulkActions, imageActions, type ImageAction, type ImageFacts } from './actions'
import { useSelectionDialog } from './dialogs'

// The action list (actions.ts) wired to the app: the stores, the backend and
// the query cache. The selection bar, Ctrl K and the right-click menu all
// call these two hooks.

/** What can be done to these images (the picks, or one right-clicked card). */
export function useBulkActions(ids: number[]): ImageAction[] {
  const favorites = useFavorites()
  const batches = useBatches()
  const templates = useBatchTemplates()
  const rate = useSetRating().mutate
  const favorite = useToggleFavorite().mutate
  const favIds = favorites.data?.ids
  const favorited = ids.length > 0 && !!favIds && ids.every((id) => favIds.has(id))
  return useMemo(
    () =>
      bulkActions({
        ids,
        favorited,
        batches: recentBatches(batches.data),
        templates: templates.data?.templates ?? [],
        ops: {
          rate: (list, stars) => rate({ ids: list, stars }),
          favorite: (list, on) => favorite({ ids: list, favorited: on }),
          dialog: (dialog, list) => useSelectionDialog.getState().showFor(dialog, list, list.length),
          censor: (list) => void quickCensor(list),
          newBatch: (kind, list, template) => askNewBatch(kind, list, 'selection', template),
          addToBatch: (batch, list) => void addPicksTo(batch, list),
        },
      }),
    [ids, favorited, batches.data, templates.data, rate, favorite],
  )
}

/** What "Copy tags" copies: the image's tags by confidence (no rating), else its prompt's tags. */
function copyableTags(detail: ImageDetailResponse): string[] {
  const own = detail.tags
    .filter((tg) => tg.category !== 'rating')
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .map((tg) => tg.tag)
  if (own.length > 0) return own
  const fromPrompt = segmentPrompt(detail.image.prompt ?? '').flatMap((seg) => (seg.kind === 'tag' ? [seg.text] : []))
  return [...new Set(fromPrompt)]
}

function factsOf(detail: ImageDetailResponse | undefined): ImageFacts | null {
  if (!detail) return null
  const image = detail.image
  return {
    prompt: image.prompt,
    negative: image.negative_prompt,
    tags: copyableTags(detail),
    parameters: image.prompt ? toParameterText(image.prompt, image.negative_prompt, readGeneration(image)) : null,
  }
}

/** What can be done to one image: open, pick, copy its parts, reach its file. */
export function useImageActions(id: number | null): ImageAction[] {
  const detail = useImageDetail(id)
  const picked = useApp((s) => (id === null ? false : s.selection.includes(id)))
  const facts = useMemo(() => factsOf(detail.data), [detail.data])
  const categories = useCategories((facts?.tags ?? []).map(tagKey))
  const groups = useMemo(() => {
    if (!facts || !categories.data) return null
    const map = categories.data
    return groupTags(facts.tags, (tag) => map.get(tagKey(tag)))
  }, [facts, categories.data])
  const path = detail.data?.image.path ?? null
  return useMemo(() => {
    if (id === null) return []
    return imageActions({
      id,
      picked,
      path,
      facts,
      groups,
      ops: {
        open: (x) => useApp.getState().openLightbox(x),
        togglePick: (x) => useApp.getState().togglePick(x),
        copy: (value, what) => void copyAndSay(value, what),
        openFolder: (x) => void openImageFolder(x),
      },
    })
  }, [id, picked, path, facts, groups])
}
