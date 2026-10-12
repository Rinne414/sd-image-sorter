import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { pt } from './privacyText'
import { compatOf, findItem, patchItem, setResult, usePrivacy, type ItemProblem, type QueueItem, type RunSummary } from './privacyStore'
import type { Direction } from './protocol'
import { runProcess, Stopped, stopProcessing, WorkerFailure } from './workerClient'

// "保护全部 / 还原全部": every image in the queue, one at a time in the worker,
// each ALWAYS from its original (V3.5 re-processed the previous result, so
// pressing Protect twice scrambled twice). The settings are taken when the run
// starts; Cancel stops the image in progress at once and leaves the rest.

class LibraryReadError extends Error {}

/** The original's bytes: the file brought in, or the library file fetched again. */
async function originalOf(item: QueueItem): Promise<Blob> {
  if (item.source.kind === 'file') return item.source.file
  const res = await fetch(`/api/image-file/${item.source.id}`, { headers: { 'X-SD-Library-Id': useApp.getState().libraryId } }).catch((error: Error) => {
    throw new LibraryReadError(error.message)
  })
  if (!res.ok) throw new LibraryReadError(`${res.status} ${res.statusText}`.trim())
  return res.blob()
}

function problemOf(error: unknown): ItemProblem {
  if (error instanceof WorkerFailure) return { code: error.problem, detail: error.message }
  if (error instanceof LibraryReadError) return { code: 'library', detail: error.message }
  return { code: 'encode', detail: String((error as Error)?.message ?? error) }
}

let stopRequested = false

interface RunSettings {
  password: string
  keepInfo: boolean
  legacyInfo: boolean
  compat: ReturnType<typeof compatOf>
}

type Outcome = 'done' | 'failed' | 'stopped' | 'gone'

async function runOne(key: number, direction: Direction, settings: RunSettings): Promise<Outcome> {
  const item = findItem(key)
  if (!item) return 'gone'
  const before = item.state
  patchItem(key, { state: 'working', problem: null })
  try {
    const source = await originalOf(item)
    if (stopRequested) throw new Stopped()
    const out = await runProcess({ direction, source, ...settings })
    const result = { blob: out.blob, url: URL.createObjectURL(out.blob), direction, compat: settings.compat, width: out.width, height: out.height, crc: out.crc, carried: out.carried }
    setResult(key, result, { width: out.sourceWidth, height: out.sourceHeight })
    return 'done'
  } catch (error) {
    if (error instanceof Stopped) {
      // what it had before (an earlier result stays valid)
      patchItem(key, { state: before === 'working' ? 'waiting' : before })
      return 'stopped'
    }
    patchItem(key, { state: 'failed', problem: problemOf(error) })
    return 'failed'
  }
}

/** One line for the end of a run (the toast and the line above the queue). */
export function summaryText(s: RunSummary): string {
  if (s.stopped) return pt('privacy.summary.stopped', { done: s.done + s.failed, total: s.total })
  const main = pt(s.direction === 'encode' ? 'privacy.summary.encode' : 'privacy.summary.decode', { done: s.done, total: s.total })
  return s.failed ? pt('privacy.summary.failed', { main, n: s.failed }) : main
}

export async function runAll(direction: Direction): Promise<void> {
  const state = usePrivacy.getState()
  if (state.run || state.items.length === 0) return
  const keys = state.items.map((it) => it.key)
  const settings = { password: state.password, keepInfo: state.options.keepInfo, legacyInfo: state.options.legacyInfo, compat: compatOf(state.options.mode) }
  stopRequested = false
  usePrivacy.setState({ run: { direction, total: keys.length, done: 0, failed: 0, stopping: false }, summary: null })

  let stopped = false
  for (const key of keys) {
    if (stopRequested) {
      stopped = true
      break
    }
    const outcome = await runOne(key, direction, settings)
    if (outcome === 'stopped') {
      stopped = true
      break
    }
    usePrivacy.setState((s) => {
      if (!s.run) return {}
      // an image removed from the queue before its turn is not counted at all
      if (outcome === 'gone') return { run: { ...s.run, total: s.run.total - 1 } }
      return { run: { ...s.run, [outcome]: s.run[outcome] + 1 } }
    })
  }

  const run = usePrivacy.getState().run
  const summary: RunSummary = { direction, total: run?.total ?? keys.length, done: run?.done ?? 0, failed: run?.failed ?? 0, stopped }
  usePrivacy.setState({ run: null, summary })
  useToasts.getState().push(summaryText(summary), summary.failed && !summary.done ? 'error' : 'info')
}

export function stopRun(): void {
  const run = usePrivacy.getState().run
  if (!run || run.stopping) return
  stopRequested = true
  usePrivacy.setState({ run: { ...run, stopping: true } })
  stopProcessing()
}
