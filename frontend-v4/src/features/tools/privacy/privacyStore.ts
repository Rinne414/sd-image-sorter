import { create } from 'zustand'
import type { Size } from './engine/imageSize'
import type { CompatMode } from './engine/password'
import type { Direction, WorkerProblem } from './protocol'

// The Privacy queue and its settings. The queue lives here, not in the page,
// so it survives going to another page and back while a run goes on; results
// are Blobs in memory until removed. Only the settings are remembered across
// reloads, never the password.

export type PrivacyMode = 'standard' | 'simple' | 'disguise'

/** The scramble family a mode belongs to; a chat disguise does not scramble, so its value is never used. */
export const compatOf = (mode: PrivacyMode): CompatMode => (mode === 'simple' ? 'small_tomato' : 'big_tomato')

export interface PrivacyOptions {
  mode: PrivacyMode
  keepInfo: boolean
  legacyInfo: boolean
  advancedOpen: boolean
}

export type ItemSource = { kind: 'file'; file: File; url: string } | { kind: 'library'; id: number }

/** A made disguise: the file the program wrote, and the cover a chat list will show. */
export interface DisguiseMade {
  token: string
  fileName: string
  outputPath: string
  width: number
  height: number
  bytes: number
  frames: number
  /** The cover as a picture (data URL). */
  coverUrl: string
}

export interface ItemResult {
  blob: Blob
  url: string
  direction: Direction
  compat: CompatMode
  width: number
  height: number
  crc: number
  carried: number
  /** Set for a made disguise. */
  disguise?: DisguiseMade
  /** Set when this is the real picture taken out of a disguise. */
  restored?: boolean
}

export type ItemState = 'waiting' | 'working' | 'done' | 'failed' | 'needs-cover' | 'packed'

export interface ItemProblem {
  code: WorkerProblem | 'library' | 'needs-cover' | 'server'
  /** The words the problem came with; for 'needs-cover' the program's reason code. */
  detail: string
  /** The program's HTTP status, for 'server'. */
  status?: number
}

export interface QueueItem {
  key: number
  source: ItemSource
  /** The original's own file name. */
  fileName: string
  /** The name the user typed for downloads (no extension); null keeps the original's. */
  rename: string | null
  /** Width and height when known (library row, the file's header, or once processed). */
  size: Size | null
  state: ItemState
  problem: ItemProblem | null
  result: ItemResult | null
}

export interface RunProgress {
  direction: Direction
  total: number
  done: number
  failed: number
  stopping: boolean
}

export interface RunSummary {
  direction: Direction
  total: number
  done: number
  failed: number
  stopped: boolean
  /** The whole line, when the run words its own end (a chat disguise run). */
  text?: string
}

interface PrivacyState {
  options: PrivacyOptions
  password: string
  items: QueueItem[]
  run: RunProgress | null
  summary: RunSummary | null
  zipping: boolean
}

const OPTIONS_KEY = 'sd-v4-privacy-options'
const DEFAULT_OPTIONS: PrivacyOptions = { mode: 'standard', keepInfo: true, legacyInfo: false, advancedOpen: false }

export function readOptions(raw: string | null): PrivacyOptions {
  try {
    const saved = JSON.parse(raw ?? 'null') as Partial<PrivacyOptions> | null
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_OPTIONS }
    return {
      mode: saved.mode === 'simple' || saved.mode === 'disguise' ? saved.mode : 'standard',
      keepInfo: typeof saved.keepInfo === 'boolean' ? saved.keepInfo : DEFAULT_OPTIONS.keepInfo,
      legacyInfo: saved.legacyInfo === true,
      advancedOpen: saved.advancedOpen === true,
    }
  } catch {
    return { ...DEFAULT_OPTIONS }
  }
}

function loadOptions(): PrivacyOptions {
  try {
    return readOptions(localStorage.getItem(OPTIONS_KEY))
  } catch {
    return { ...DEFAULT_OPTIONS }
  }
}

export const usePrivacy = create<PrivacyState>(() => ({
  options: loadOptions(),
  password: '',
  items: [],
  run: null,
  summary: null,
  zipping: false,
}))

export function setOptions(patch: Partial<PrivacyOptions>): void {
  const options = { ...usePrivacy.getState().options, ...patch }
  usePrivacy.setState({ options })
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options))
  } catch {
    // storage blocked: the choice lasts until reload
  }
}

export const setPassword = (password: string): void => usePrivacy.setState({ password })

let keys = 0
export const nextKey = (): number => ++keys

export function appendItems(items: QueueItem[]): void {
  usePrivacy.setState((s) => ({ items: [...s.items, ...items] }))
}

export function patchItem(key: number, patch: Partial<QueueItem>): void {
  usePrivacy.setState((s) => ({ items: s.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) }))
}

export const findItem = (key: number): QueueItem | undefined => usePrivacy.getState().items.find((it) => it.key === key)

function release(item: QueueItem): void {
  if (item.source.kind === 'file') URL.revokeObjectURL(item.source.url)
  if (item.result) URL.revokeObjectURL(item.result.url)
}

/** Put a new result on an item (dropping the one it replaces); a result for an item removed meanwhile is dropped. */
export function setResult(key: number, result: ItemResult, size: Size | null): void {
  const item = findItem(key)
  if (!item) {
    URL.revokeObjectURL(result.url)
    return
  }
  if (item.result) URL.revokeObjectURL(item.result.url)
  patchItem(key, size ? { state: 'done', problem: null, result, size } : { state: 'done', problem: null, result })
}

/** Change an item and drop the result it had (that picture is no longer what the item says). */
export function dropResult(key: number, patch: Partial<QueueItem>): void {
  const item = findItem(key)
  if (item?.result) URL.revokeObjectURL(item.result.url)
  patchItem(key, { ...patch, result: null })
}

export function removeItem(key: number): void {
  const item = findItem(key)
  if (!item || item.state === 'working') return
  release(item)
  usePrivacy.setState((s) => ({ items: s.items.filter((it) => it.key !== key), summary: null }))
}

export function clearQueue(): void {
  const s = usePrivacy.getState()
  if (s.run) return
  s.items.forEach(release)
  usePrivacy.setState({ items: [], summary: null })
}

export function renameItem(key: number, name: string): void {
  patchItem(key, { rename: name.trim() || null })
}
