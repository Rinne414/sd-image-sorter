import type { BatchItem } from '../../api/types'
import { useToasts } from '../../ui/toasts'
import { addJob, isQueueBusy, setDetectSource, startingProgress, tr } from '../jobs/jobs'
import { applyRefined, refinable } from './detection'
import { detectImage, refineRegions, type DetectPlan } from './detectApi'
import { applyChange, applyDetections, cardsFor, loadCensorModels, makePlan, opsNow, pictureSize, reason, withModels } from './detectRun'
import { useDetectSettings } from './detectSettings'
import { useCensorPanel } from './panel'
import { detectAllTargets, nextToReview, type ReviewItem } from './review'
import { saveOutcome } from './saveFlow'
import { libraryFor, saveImage } from './saving'
import { editOf, initialEdit, keyOf, useCensorSession } from './session'

// "Detect all" and "SAM3 refine all" over a batch: one job in the Jobs drawer
// that works through the images one by one in this page. Each image's result
// goes into its op list (manual strokes untouched) and is saved with a
// "waiting for review" mark right away, so a reload loses nothing. Stop ends
// it after the image being worked on; running it again goes on with the rest.

type RunKind = 'detect' | 'refine'

/** What the Jobs drawer polls; the shape its progress reader expects. Owned by the one run going. */
interface RunState {
  status: 'running' | 'cancelling' | 'done' | 'cancelled'
  current: number
  total: number
  succeeded: number
  failed: { image_id: number; filename: string; error: string }[]
  current_item: string | null
}

let run: RunState | null = null
let stopAsked = false

setDetectSource({
  snapshot: () => (run ? { ...run, failed: [...run.failed] } : null),
  cancel: () => {
    if (!run || run.status !== 'running') return
    stopAsked = true
    run.status = 'cancelling'
  },
})

const toast = (text: string, kind: 'info' | 'error' = 'info') => useToasts.getState().push(text, kind)

/**
 * Save the image's new ops; a failure to save is this image's failure. When a
 * save of the image is already running (the user just left it), this waits
 * for the save that carries the result before deciding.
 */
async function store(batchId: number, item: BatchItem): Promise<void> {
  const saved = await saveImage(batchId, item.image_id)
  const outcome = saveOutcome(saved, editOf(batchId, item.image_id))
  if (!outcome.ok) throw new Error(outcome.reason ?? tr('censor.all.gone'))
}

async function runJob(kind: RunKind, batchId: number, items: BatchItem[], work: (item: BatchItem) => Promise<void>): Promise<RunState> {
  const state: RunState = { status: 'running', current: 0, total: items.length, succeeded: 0, failed: [], current_item: null }
  run = state
  stopAsked = false
  addJob({ kind, count: items.length, ids: items.map((i) => i.image_id), progress: startingProgress(items.length) })
  for (const item of items) {
    if (stopAsked) break
    state.current_item = item.filename
    try {
      await work(item)
      await store(batchId, item)
      state.succeeded++
    } catch (error) {
      state.failed.push({ image_id: item.image_id, filename: item.filename, error: reason(error) })
    }
    state.current++
  }
  state.current_item = null
  state.status = stopAsked ? 'cancelled' : 'done'
  return state
}

const reviewItems = (batchId: number, items: readonly BatchItem[]): ReviewItem[] =>
  items.map((item) => ({ imageId: item.image_id, reviewed: (editOf(batchId, item.image_id) ?? initialEdit(item)).reviewed }))

/** After detect all: review mode, on the first image waiting for review. */
function openReview(batchId: number, items: readonly BatchItem[]): void {
  const marks = reviewItems(batchId, items)
  const first = marks[0]?.reviewed === false ? 0 : nextToReview(marks, 0)
  const target = first === null ? undefined : marks[first]
  useCensorPanel.setState({ tab: 'review', jump: target ? { batchId, imageId: target.imageId } : null })
}

/** Detect `targets`; `items` is the whole batch (review opens on its first image waiting). */
async function detectAllNow(batchId: number, items: BatchItem[], targets: BatchItem[], plan: DetectPlan): Promise<void> {
  const warnings = new Set<string>()
  const done = await runJob('detect', batchId, targets, async (item) => {
    const result = await detectImage(item.image_id, plan, libraryFor(batchId), await pictureSize(item.image_id))
    for (const w of result.warnings) warnings.add(w)
    await applyDetections(batchId, item, result.regions)
  })
  if (warnings.size) toast([...warnings].join(' '), 'error')
  if (done.status === 'done' && done.succeeded > 0) openReview(batchId, items)
}

/** Detect every image not detected yet (or, when there is none, re-detect the ones waiting for review). */
export async function startDetectAll(batchId: number, items: BatchItem[]): Promise<void> {
  if (isQueueBusy('detect')) return void toast(tr('jobs.busy'), 'error')
  const { ids } = detectAllTargets(reviewItems(batchId, items))
  const targets = items.filter((item) => ids.includes(item.image_id))
  if (targets.length === 0) return void toast(tr('censor.all.nothing'))
  const plan = makePlan(await loadCensorModels())
  if ('error' in plan) return void toast(tr(plan.error), 'error')
  const cards = cardsFor(plan.detector, useDetectSettings.getState().customPath)
  await withModels(cards, 'censor.ask.forDetect', () => void detectAllNow(batchId, items, targets, plan))
}

/** Images SAM3 can refine: detected boxes, not approved yet. */
export function refineTargets(batchId: number, items: readonly BatchItem[], edits = useCensorSession.getState().edits): BatchItem[] {
  return items.filter((item) => {
    const edit = edits[keyOf(batchId, item.image_id)] ?? initialEdit(item)
    return edit.reviewed !== true && refinable(edit.ops).length > 0
  })
}

async function refineAllNow(batchId: number, items: BatchItem[]): Promise<void> {
  const confidence = useDetectSettings.getState().confidence
  let kept = 0
  const done = await runJob('refine', batchId, items, async (item) => {
    const regions = refinable(opsNow(batchId, item))
    const result = await refineRegions(item.image_id, regions, confidence, libraryFor(batchId), await pictureSize(item.image_id))
    if (result.shapes.size === 0 && result.errors.length > 0) throw new Error(result.errors[0])
    kept += result.kept
    await applyChange(batchId, item, (ops) => applyRefined(ops, result.shapes), false)
  })
  if (kept > 0 && done.succeeded > 0) toast(tr('censor.refine.keptBoxes', { n: kept }))
}

/** SAM3 refine of every detected image not approved yet. */
export async function startRefineAll(batchId: number, items: BatchItem[]): Promise<void> {
  if (isQueueBusy('refine')) return void toast(tr('jobs.busy'), 'error')
  const targets = refineTargets(batchId, items)
  if (targets.length === 0) return void toast(tr('censor.refine.nothingAll'), 'error')
  await withModels(cardsFor('sam3'), 'censor.ask.forSam3', () => void refineAllNow(batchId, targets))
}
