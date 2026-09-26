import { create } from 'zustand'
import { ApiError } from '../../../api/client'
import { fetchModelStatus } from '../../../api/queries'
import { queryClient } from '../../../api/queryClient'
import type { TargetModel } from '../../batch/datasetSettings'
import { busyText } from '../../jobs/busyText'
import { installThen } from '../../jobs/installJob'
import type { TagOptions } from '../../tagging/tagJob'
import { readiness, taggerInfo, type ModelCard } from '../../tagging/taggers'
import { createSourceStore } from '../intake/sourceStore'
import { tt } from '../toolText'
import { MODES, needsTagger, type ReverseMode } from './reverseModes'
import { Cancelled, runSmartTag, runTagger, type ReverseResult, type RunPhase } from './runReverse'

// Reverse prompt's state: its own image (separate from the Reader's), the
// way and target model (remembered), the draft (kept across restarts), and
// the run in flight. A run belongs to the image it started on: a result for
// another image is never shown.

const source = createSourceStore()
export const useReverseSource = source.useSource
export const openReverseUpload = source.openUpload
export const openReverseLibraryImage = source.openLibraryImage
export const clearReverse = source.clear

// ---- remembered choices -------------------------------------------------------

const OPTIONS_KEY = 'sd-v4-reverse-options'
const DRAFT_KEY = 'sd-v4-reverse-draft'
const TARGETS: readonly TargetModel[] = ['', 'sdxl', 'flux', 'krea2', 'anima']

function loadOptions(): { mode: ReverseMode; target: TargetModel } {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as { mode?: unknown; target?: unknown }
    const mode = MODES.find((m) => m === raw.mode) ?? 'grounded'
    const target = TARGETS.find((m) => m === raw.target) ?? ''
    return { mode, target }
  } catch {
    return { mode: 'grounded', target: '' }
  }
}

function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage blocked: kept for this visit only
  }
}

export const useReverseOptions = create<{ mode: ReverseMode; target: TargetModel }>(loadOptions)

export function setReverseOptions(patch: Partial<{ mode: ReverseMode; target: TargetModel }>): void {
  useReverseOptions.setState(patch)
  store(OPTIONS_KEY, JSON.stringify(useReverseOptions.getState()))
}

export const useDraft = create<{ text: string }>(() => ({ text: loadDraft() }))

export function setDraft(text: string): void {
  useDraft.setState({ text })
  store(DRAFT_KEY, text)
}

// ---- the run --------------------------------------------------------------

type Phase = 'idle' | 'installing' | 'starting' | RunPhase

interface RunState {
  phase: Phase
  /** The image the run in flight (or the last result) belongs to. */
  key: string | null
  result: ReverseResult | null
  /** How the run in flight / the result was worked out, in words (which tagger, which vision model). */
  method: string
  /** A failure in the user's words, or 'cancelled'. */
  problem: string | null
  controller: AbortController | null
}

export const useReverseRun = create<RunState>(() => ({ phase: 'idle', key: null, result: null, method: '', problem: null, controller: null }))

const mine = (key: string) => useReverseRun.getState().key === key

function failed(key: string, error: unknown): void {
  if (!mine(key)) return
  const problem =
    error instanceof Cancelled ? 'cancelled' : error instanceof ApiError && error.status === 409 ? busyText(error) : tt('reverse.failed', { reason: (error as Error).message })
  useReverseRun.setState({ phase: 'idle', problem, controller: null })
}

export interface RunInput {
  key: string
  /** The file the tagger / vision model reads: the upload's kept copy, or the library file. */
  path: string
  mode: ReverseMode
  target: TargetModel
  tagger: TagOptions
  method: string
}

async function go(input: RunInput, controller: AbortController): Promise<void> {
  const { key, path, mode, target, tagger } = input
  const hooks = { signal: controller.signal, onPhase: (phase: RunPhase) => mine(key) && useReverseRun.setState({ phase }) }
  try {
    const result = mode === 'tagger' ? await runTagger(path, tagger, hooks) : await runSmartTag(mode, path, target, tagger, hooks)
    if (mine(key)) useReverseRun.setState({ phase: 'idle', result, problem: null, controller: null })
  } catch (error) {
    failed(key, error)
  }
}

async function cardsNow(): Promise<ModelCard[] | undefined> {
  try {
    return (await queryClient.fetchQuery({ queryKey: ['model-status'], queryFn: () => fetchModelStatus(), staleTime: 0 })).models
  } catch {
    return undefined // unknown: the download step checks for itself
  }
}

/** Start working out a prompt; a tagger that is not on disk is downloaded first (a job in the drawer). */
export async function startRun(input: RunInput): Promise<void> {
  cancelRun()
  const controller = new AbortController()
  useReverseRun.setState({ phase: 'starting', key: input.key, result: null, method: input.method, problem: null, controller })
  if (!needsTagger(input.mode)) return go(input, controller)
  const info = taggerInfo(input.tagger.model)
  const state = readiness(info, await cardsNow())
  if (state === 'restart') return failed(input.key, new Error(tt('reverse.taggerRestart', { name: info.label })))
  if (state === 'ready') return go(input, controller)
  useReverseRun.setState({ phase: 'installing' })
  const queued = await installThen(info, () => {
    if (!controller.signal.aborted) void go(input, controller)
  })
  if (!queued) failed(input.key, new Error(tt('reverse.downloadFailed', { name: info.label })))
}

/** Stop the run in flight (a vision-model run still waiting stops as soon as its turn comes). */
export function cancelRun(): void {
  const { controller, phase } = useReverseRun.getState()
  if (!controller || controller.signal.aborted) return
  controller.abort()
  if (phase === 'installing' || phase === 'starting') useReverseRun.setState({ phase: 'idle', problem: 'cancelled', controller: null })
  else useReverseRun.setState({ phase: 'cancelling' })
}

/** Another image came in: the run and result of the last one go. */
export function forgetRunUnless(key: string): void {
  const s = useReverseRun.getState()
  if (s.key === key) return
  cancelRun()
  useReverseRun.setState({ phase: 'idle', key, result: null, method: '', problem: null, controller: null })
}
