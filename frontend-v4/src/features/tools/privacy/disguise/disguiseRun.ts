import { ApiError } from '../../../../api/client'
import { useToasts } from '../../../../ui/toasts'
import { useDetectSettings } from '../../../censor/detectSettings'
import { dropResult, findItem, patchItem, setResult, usePrivacy, type ItemProblem, type ItemResult, type QueueItem, type RunSummary } from '../privacyStore'
import type { Direction } from '../protocol'
import { LibraryReadError, originalOf } from '../source'
import { fetchMade, makeDisguise, restoreDisguise, type MakeRequest } from './disguiseApi'
import { detectorChoice, folderOf, makeFields, needsCover, type DisguiseSettings, type MakeAnswer } from './disguiseModel'
import { setPack, useDisguise } from './disguiseStore'
import { dt, errorText } from './disguiseText'

// "Make disguise" and "Restore" for the whole queue. Pictures go to the
// program on this computer one at a time (a pack is one request); Cancel
// finishes the picture in hand and leaves the rest. Each picture ends in one
// of: made (and where it was written), needs another cover (and why), or
// failed (and why), so the end line can say exactly what happened.

let stopRequested = false

/** Cancel: the picture being made is finished, the rest are left. */
export const stopDisguise = (): void => {
  stopRequested = true
}

type Made = Extract<MakeAnswer, { status: 'ok' }>
type Outcome = 'done' | 'waiting' | 'failed' | 'gone'

interface Tally {
  done: number
  waiting: number
  failed: number
  /** Where the files of this run were written. */
  folder: string
}

const problemFrom = (error: unknown): ItemProblem => {
  if (error instanceof ApiError) return { code: 'server', detail: error.message, status: error.status }
  if (error instanceof LibraryReadError) return { code: 'library', detail: error.message }
  return { code: 'server', detail: String((error as Error)?.message ?? error) }
}

/** What one make request carries for these pictures. */
function requestFor(items: readonly QueueItem[], settings: DisguiseSettings, outputName: string | null): MakeRequest {
  const sources: MakeRequest['sources'] = []
  const uploads: MakeRequest['uploads'] = []
  for (const item of items) {
    if (item.source.kind === 'library') {
      sources.push({ image_id: item.source.id })
    } else {
      sources.push({ file_index: uploads.length })
      uploads.push({ file: item.source.file, name: item.fileName })
    }
  }
  const censor = useDetectSettings.getState()
  const detector = detectorChoice(censor.detector, censor.yolo, censor.customPath, censor.confidence, censor.targets)
  const coverFile = needsCover(settings) && settings.coverKind === 'upload' ? (useDisguise.getState().uploadCover?.file ?? null) : null
  return { sources, uploads, coverFile, fields: makeFields(settings, { defaultText: dt('disguise.cover.textPlaceholder'), outputName, detector }) }
}

const madeInfo = (a: Made) => ({ token: a.token, fileName: a.file_name, outputPath: a.output_path, width: a.width, height: a.height, bytes: a.bytes, frames: a.real_frames, coverUrl: a.cover_preview })

async function makeOne(key: number, settings: DisguiseSettings, tally: Tally): Promise<Outcome> {
  const item = findItem(key)
  if (!item) return 'gone'
  patchItem(key, { state: 'working', problem: null })
  try {
    const answer = await makeDisguise(requestFor([item], settings, item.rename))
    if (answer.status === 'needs_cover') {
      dropResult(key, { state: 'needs-cover', problem: { code: 'needs-cover', detail: answer.reason } })
      return 'waiting'
    }
    const blob = await fetchMade(answer.file_url)
    const result: ItemResult = { blob, url: URL.createObjectURL(blob), direction: 'encode', compat: 'big_tomato', width: answer.width, height: answer.height, crc: 0, carried: 0, disguise: madeInfo(answer) }
    setResult(key, result, null)
    tally.folder = folderOf(answer.output_path)
    return 'done'
  } catch (error) {
    patchItem(key, { state: 'failed', problem: problemFrom(error) })
    return 'failed'
  }
}

function begin(direction: Direction, total: number): void {
  stopRequested = false
  usePrivacy.setState({ run: { direction, total, done: 0, failed: 0, stopping: false }, summary: null })
}

function finish(summary: RunSummary): void {
  usePrivacy.setState({ run: null, summary })
  useToasts.getState().push(summary.text ?? '', summary.failed > 0 && summary.done === 0 ? 'error' : 'info')
}

const sentence = (parts: string[]): string => parts.filter(Boolean).join(' ')

function madeText(t: Tally, total: number, stopped: boolean): string {
  const handled = t.done + t.waiting + t.failed
  return sentence([
    t.done ? dt('disguise.summary.made', { n: t.done, folder: t.folder }) : dt('disguise.summary.none'),
    t.waiting ? dt('disguise.summary.waiting', { n: t.waiting }) : '',
    t.failed ? dt('disguise.summary.failed', { n: t.failed }) : '',
    stopped ? dt('disguise.summary.stopped', { done: handled, total }) : '',
  ])
}

/** Count one finished picture; a picture removed before its turn is not counted at all. */
function count(outcome: Outcome, tally: Tally): void {
  if (outcome === 'gone') {
    usePrivacy.setState((s) => (s.run ? { run: { ...s.run, total: s.run.total - 1 } } : {}))
    return
  }
  tally[outcome] += 1
  // a picture waiting for a cover is handled too: the progress counts it with the made ones
  const field = outcome === 'failed' ? 'failed' : 'done'
  usePrivacy.setState((s) => (s.run ? { run: { ...s.run, [field]: s.run[field] + 1 } } : {}))
}

async function makeEach(keys: number[], settings: DisguiseSettings): Promise<void> {
  const tally: Tally = { done: 0, waiting: 0, failed: 0, folder: '' }
  begin('encode', keys.length)
  let stopped = false
  for (const key of keys) {
    if (stopRequested) {
      stopped = true
      break
    }
    count(await makeOne(key, settings, tally), tally)
  }
  const total = usePrivacy.getState().run?.total ?? keys.length
  finish({ direction: 'encode', total, done: tally.done, failed: tally.failed, stopped, text: madeText(tally, total, stopped) })
}

/** All pictures into one file; one request, so Cancel cannot cut it short. */
async function makePack(keys: number[], settings: DisguiseSettings): Promise<void> {
  const items = keys.map(findItem).filter((it): it is QueueItem => !!it)
  begin('encode', items.length)
  items.forEach((it) => patchItem(it.key, { state: 'working', problem: null }))
  const reset = (state: QueueItem['state'], problem: ItemProblem | null) => items.forEach((it) => dropResult(it.key, { state, problem }))
  const summary = (text: string, failed: number, done: number): RunSummary => ({ direction: 'encode', total: items.length, done, failed, stopped: false, text })
  try {
    const answer = await makeDisguise(requestFor(items, settings, null))
    if (answer.status === 'needs_cover') {
      reset('needs-cover', { code: 'needs-cover', detail: answer.reason })
      finish(summary(dt('disguise.summary.waiting', { n: items.length }), 0, 0))
      return
    }
    const blob = await fetchMade(answer.file_url)
    const format = settings.packFormat === 'gif' ? 'gif' : 'disguise'
    setPack({ ...madeInfo(answer), format, blob, url: URL.createObjectURL(blob) })
    items.forEach((it) => patchItem(it.key, { state: 'packed', problem: null }))
    const key = format === 'gif' ? 'disguise.summary.gif' : 'disguise.summary.pack'
    finish(summary(dt(key, { n: items.length, name: answer.file_name, folder: folderOf(answer.output_path) }), 0, items.length))
  } catch (error) {
    reset('failed', problemFrom(error))
    finish(summary(`${dt('disguise.summary.failed', { n: items.length })} ${errorText(error)}`, items.length, 0))
  }
}

async function restoreOne(key: number): Promise<Outcome> {
  const item = findItem(key)
  if (!item) return 'gone'
  patchItem(key, { state: 'working', problem: null })
  try {
    const blob = await restoreDisguise(await originalOf(item), item.fileName)
    const result: ItemResult = { blob, url: URL.createObjectURL(blob), direction: 'decode', compat: 'big_tomato', width: 0, height: 0, crc: 0, carried: 0, restored: true }
    setResult(key, result, null)
    return 'done'
  } catch (error) {
    patchItem(key, { state: 'failed', problem: problemFrom(error) })
    return 'failed'
  }
}

async function restoreEach(keys: number[]): Promise<void> {
  const tally: Tally = { done: 0, waiting: 0, failed: 0, folder: '' }
  begin('decode', keys.length)
  let stopped = false
  for (const key of keys) {
    if (stopRequested) {
      stopped = true
      break
    }
    count(await restoreOne(key), tally)
  }
  const total = usePrivacy.getState().run?.total ?? keys.length
  const text = sentence([dt('disguise.summary.restored', { done: tally.done, total }), tally.failed ? dt('disguise.summary.failed', { n: tally.failed }) : '', stopped ? dt('disguise.summary.stopped', { done: tally.done + tally.failed, total }) : ''])
  finish({ direction: 'decode', total, done: tally.done, failed: tally.failed, stopped, text })
}

/** Make or restore the whole queue with the saved settings. */
export async function runDisguise(direction: Direction): Promise<void> {
  const keys = usePrivacy.getState().items.map((it) => it.key)
  if (direction === 'decode') return restoreEach(keys)
  const { settings, uploadCover } = useDisguise.getState()
  if (needsCover(settings) && settings.coverKind === 'upload' && !uploadCover) {
    useToasts.getState().push(dt('disguise.cover.pickFirst'), 'error')
    return
  }
  setPack(null)
  return settings.pack ? makePack(keys, settings) : makeEach(keys, settings)
}

/** Make the pictures again with the default cover: only the ones waiting for a cover, or all of them. */
export async function redoWithDefaultCover(scope: 'failed' | 'all'): Promise<void> {
  const state = usePrivacy.getState()
  if (state.run) return
  const settings: DisguiseSettings = { ...useDisguise.getState().settings, coverKind: 'default' }
  const keys = state.items.filter((it) => scope === 'all' || it.state === 'needs-cover').map((it) => it.key)
  if (!keys.length) return
  if (scope === 'all') setPack(null)
  if (scope === 'all' && settings.pack) return makePack(keys, settings)
  return makeEach(keys, settings)
}
