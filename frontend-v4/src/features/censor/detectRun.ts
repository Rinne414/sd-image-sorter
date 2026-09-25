import { create } from 'zustand'
import { fetchModelStatus } from '../../api/queries'
import { queryClient } from '../../api/queryClient'
import type { BatchItem } from '../../api/types'
import type { MessageKey } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { installAllThen, type InstallTarget } from '../jobs/installJob'
import { tr } from '../jobs/jobs'
import type { ModelCard } from '../tagging/taggers'
import { isDrawing } from './CanvasView'
import { applyDetectRun, applyRefined, applyTextRun, refinable, textDetector } from './detection'
import { censorModelsQuery, detectImage, refineRegions, segmentWord, type CensorModels, type DetectPlan } from './detectApi'
import { effectiveDetector, promptWords, usesTargets, useDetectSettings, type DetectorId } from './detectSettings'
import type { Op, RegionOp } from './ops'
import { useCensorPanel } from './panel'
import { libraryFor } from './saving'
import { changeOps, editOf, initialEdit, setReviewed } from './session'
import { useCensorSettings } from './settings'

// Running detection on one image: what to send, making sure the model is on
// disk first (asking before any download), and putting the result into the
// image's op list through applyDetectRun / applyTextRun / applyRefined, which
// never touch a manual stroke.

// ---- what a run needs ----

const MODEL_CARDS: Record<'censor-nudenet' | 'censor-legacy' | 'sam3', InstallTarget & { size: string | null }> = {
  'censor-nudenet': { card: 'censor-nudenet', variant: null, label: 'NudeNet v3', size: '12 MB' },
  'censor-legacy': { card: 'censor-legacy', variant: null, label: 'Privacy YOLO', size: null },
  sam3: { card: 'sam3', variant: null, label: 'SAM 3', size: '3.3 GB' },
}
type CardId = keyof typeof MODEL_CARDS

/**
 * The model cards a detector (or the SAM3 tools: 'sam3') needs. "Both" needs
 * NudeNet; without the YOLO file the backend runs NudeNet alone and says so.
 */
export function cardsFor(detector: DetectorId, customPath = ''): CardId[] {
  if (detector === 'nudenet' || detector === 'both') return ['censor-nudenet']
  if (detector === 'legacy') return customPath.trim() ? [] : ['censor-legacy']
  return ['sam3']
}

type CardState = 'ready' | 'download' | 'restart' | 'check'

/** Censor cards say "ready" only when the model can run (NudeNet's weights included). */
function cardState(card: ModelCard | undefined): CardState {
  if (!card) return 'check'
  if (card.status === 'needs_restart') return 'restart'
  return card.status === 'ready' ? 'ready' : 'download'
}

export interface DownloadAsk {
  models: { label: string; size: string | null }[]
  /** What the downloads are for. */
  purpose: MessageKey
  yes: () => void
}

/** The "download first?" question waiting for an answer (shown by DownloadConfirm). */
export const useDownloadAsk = create<{ ask: DownloadAsk | null }>(() => ({ ask: null }))

const toast = (text: string, kind: 'info' | 'error' = 'info') => useToasts.getState().push(text, kind)

/**
 * Run `work` once every model it needs is on disk. Missing models are named
 * with their size and downloaded as jobs only after the user says yes.
 */
export async function withModels(cards: CardId[], purpose: MessageKey, work: () => void): Promise<void> {
  let status: ModelCard[] | undefined
  try {
    status = (await queryClient.fetchQuery({ queryKey: ['model-status'], queryFn: () => fetchModelStatus(), staleTime: 0 })).models
  } catch {
    status = undefined // unknown: the run itself reports a missing model
  }
  const states = cards.map((id) => ({ id, state: cardState(status?.find((c) => c.id === id)) }))
  const restart = states.find((s) => s.state === 'restart')
  if (restart) return void toast(tr('tagging.needsRestart', { name: MODEL_CARDS[restart.id].label }), 'error')
  const missing = states.filter((s) => s.state === 'download').map((s) => MODEL_CARDS[s.id])
  if (missing.length === 0) return work()
  useDownloadAsk.setState({
    ask: {
      models: missing.map((m) => ({ label: m.label, size: m.size })),
      purpose,
      yes: () => void installAllThen(missing, work),
    },
  })
}

// ---- the plan for a detect run ----

export async function loadCensorModels(): Promise<CensorModels | undefined> {
  try {
    return await queryClient.fetchQuery(censorModelsQuery)
  } catch {
    return undefined
  }
}

function legacyTargets(models: CensorModels | undefined, path: string): boolean {
  const legacy = models?.models.find((m) => m.id === 'legacy')
  const file = legacy?.files?.find((f) => f.path === (path || legacy.default_model_path))
  return !!file && (file.profile === 'privacy-censor' || file.recommended_for_censor === true)
}

/** What to send for a detect run, or the reason it cannot start. */
export function makePlan(models: CensorModels | undefined): DetectPlan | { error: MessageKey } {
  const s = useDetectSettings.getState()
  const tool = useCensorSettings.getState()
  const detector = effectiveDetector(s.detector, models?.recommended_backend)
  const modelPath = detector === 'legacy' || detector === 'both' ? s.customPath.trim() || s.yolo : ''
  const filtered = usesTargets(detector) && (detector !== 'legacy' || legacyTargets(models, modelPath))
  if (filtered && s.targets.length === 0) return { error: 'censor.detect.noTargets' }
  return {
    detector,
    modelPath,
    targets: filtered ? [...s.targets] : null,
    confidence: s.confidence,
    maskShape: s.maskShape,
    words: detector === 'sam3' ? promptWords(s.prompt) : [],
    style: tool.style,
    block: tool.block,
  }
}

// ---- applying results ----

/** A stroke in progress owns the picture: results wait until the pointer lets go. */
async function whenIdle(): Promise<void> {
  while (isDrawing()) await new Promise((resolve) => setTimeout(resolve, 50))
}

export const opsNow = (batchId: number, item: BatchItem): Op[] => (editOf(batchId, item.image_id) ?? initialEdit(item)).ops

/** Put a change to the latest op list (one undo step); detection results also mark the image "waiting for review". */
export async function applyChange(batchId: number, item: BatchItem, change: (ops: Op[]) => Op[], detected: boolean): Promise<void> {
  await whenIdle()
  changeOps(batchId, item, change(opsNow(batchId, item)))
  if (detected) setReviewed(batchId, item, false)
}

export const applyDetections = (batchId: number, item: BatchItem, regions: RegionOp[]) =>
  applyChange(batchId, item, (ops) => applyDetectRun(ops, regions), true)

// ---- one image, from the panel or a key ----

type BusyKind = 'detect' | 'refine' | 'text'

/** What is running on which image (`batch:image`), for the panel and the status line. */
export const useDetectBusy = create<{ busy: Record<string, BusyKind> }>(() => ({ busy: {} }))

async function busyWhile<T>(key: string, kind: BusyKind, work: () => Promise<T>): Promise<T> {
  useDetectBusy.setState((s) => ({ busy: { ...s.busy, [key]: kind } }))
  try {
    return await work()
  } finally {
    useDetectBusy.setState((s) => {
      const busy = { ...s.busy }
      delete busy[key]
      return { busy }
    })
  }
}

export const reason = (error: unknown) => (error as Error).message || tr('censor.saveUnknown')

async function detectNow(batchId: number, item: BatchItem, plan: DetectPlan): Promise<void> {
  try {
    const { regions, warnings } = await busyWhile(`${batchId}:${item.image_id}`, 'detect', () => detectImage(item.image_id, plan, libraryFor(batchId)))
    await applyDetections(batchId, item, regions)
    // In review the region list already shows what was found; elsewhere say it.
    if (regions.length === 0) toast(tr('censor.detect.none'))
    else if (useCensorPanel.getState().tab !== 'review') toast(tr('censor.detect.found', { n: regions.length }))
    if (warnings.length) toast(warnings.join(' '), 'error')
  } catch (error) {
    toast(tr('censor.detect.failed', { reason: reason(error) }), 'error')
  }
}

/** D / "detect this image": re-detecting replaces earlier detector regions, never strokes. */
export async function detectCurrent(batchId: number, item: BatchItem): Promise<void> {
  if (useDetectBusy.getState().busy[`${batchId}:${item.image_id}`]) return
  const plan = makePlan(await loadCensorModels())
  if ('error' in plan) return void toast(tr(plan.error), 'error')
  await withModels(cardsFor(plan.detector, useDetectSettings.getState().customPath), 'censor.ask.forDetect', () => void detectNow(batchId, item, plan))
}

async function refineNow(batchId: number, item: BatchItem): Promise<void> {
  const regions = refinable(opsNow(batchId, item))
  if (regions.length === 0) return void toast(tr('censor.refine.nothing'), 'error')
  try {
    const confidence = useDetectSettings.getState().confidence
    const result = await busyWhile(`${batchId}:${item.image_id}`, 'refine', () => refineRegions(item.image_id, regions, confidence, libraryFor(batchId)))
    await applyChange(batchId, item, (ops) => applyRefined(ops, result.shapes), false)
    toast(tr('censor.refine.done', { n: result.shapes.size, kept: result.kept }), result.errors.length ? 'error' : 'info')
  } catch (error) {
    toast(tr('censor.refine.failed', { reason: reason(error) }), 'error')
  }
}

/** SAM3 refine of this image's detected boxes. */
export function refineCurrent(batchId: number, item: BatchItem): Promise<void> {
  return withModels(cardsFor('sam3'), 'censor.ask.forSam3', () => void refineNow(batchId, item))
}

async function segmentNow(batchId: number, item: BatchItem, words: string[]): Promise<void> {
  const { style, block } = useCensorSettings.getState()
  const key = `${batchId}:${item.image_id}`
  const missed: string[] = []
  try {
    await busyWhile(key, 'text', async () => {
      for (const word of words) {
        const region = await segmentWord(item.image_id, word, style, block, libraryFor(batchId))
        const detector = textDetector(word)
        if (!region) missed.push(word)
        // Nothing found and nothing found before: the list stays as it is.
        if (!region && !opsNow(batchId, item).some((op) => op.type === 'region' && op.detector === detector)) continue
        await applyChange(batchId, item, (ops) => applyTextRun(ops, detector, region ? [region] : []), !!region)
      }
    })
    toast(missed.length ? tr('censor.text.missed', { words: missed.join(', ') }) : tr('censor.text.done', { n: words.length }))
  } catch (error) {
    toast(tr('censor.text.failed', { reason: reason(error) }), 'error')
  }
}

/** SAM3 text segmentation of this image: one region per word. */
export async function segmentCurrent(batchId: number, item: BatchItem): Promise<void> {
  const words = promptWords(useDetectSettings.getState().prompt)
  if (words.length === 0) return void toast(tr('censor.text.noWords'), 'error')
  await withModels(cardsFor('sam3'), 'censor.ask.forSam3', () => void segmentNow(batchId, item, words))
}
