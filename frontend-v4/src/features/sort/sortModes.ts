import { shortModelName, type GenerationInfo } from '../../lib/meta'
import type { Duel, SlotKey, SortAction, SortImage, SortMode } from './sortSession'

// What differs between the three ways to sort: which key means what, what
// the A/B pair has in common, and the pace of the keys. Pure.

export interface KeyLike {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

const LETTER_CODES: Record<string, string> = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyK: 'k', KeyX: 'x', KeyZ: 'z', KeyY: 'y' }

/** Keys of A/B: ← or A keeps A, → or D takes B, Space / ↑ / W skips B. */
const BRACKET_KEYS: Record<string, SortAction> = {
  ArrowLeft: { kind: 'pick', side: 'a' },
  a: { kind: 'pick', side: 'a' },
  ArrowRight: { kind: 'pick', side: 'b' },
  d: { kind: 'pick', side: 'b' },
  ' ': { kind: 'skip' },
  ArrowUp: { kind: 'skip' },
  w: { kind: 'skip' },
}

/** Keys of keep/reject: → D K keep, ← A X reject, Space ↑ ↓ W S skip. */
const CULL_KEYS: Record<string, SortAction> = {
  ArrowRight: { kind: 'keep' },
  d: { kind: 'keep' },
  k: { kind: 'keep' },
  ArrowLeft: { kind: 'reject' },
  a: { kind: 'reject' },
  x: { kind: 'reject' },
  ' ': { kind: 'skip' },
  ArrowUp: { kind: 'skip' },
  ArrowDown: { kind: 'skip' },
  w: { kind: 'skip' },
  s: { kind: 'skip' },
}

/** The letter or key meant, by key position first (any layout, a Chinese input method on). */
function keyName(e: KeyLike): string {
  const code = e.code ?? ''
  if (LETTER_CODES[code]) return LETTER_CODES[code]
  if (code === 'Space') return ' '
  return e.key.length === 1 ? e.key.toLowerCase() : e.key
}

function historyKey(e: KeyLike, key: string): SortAction | null {
  if (e.ctrlKey || e.metaKey) {
    if (key === 'z') return e.shiftKey ? { kind: 'redo' } : { kind: 'undo' }
    return key === 'y' ? { kind: 'redo' } : null
  }
  if (key === 'Backspace' || key === 'z') return { kind: 'undo' }
  return key === 'y' ? { kind: 'redo' } : null
}

/** The key's meaning on the Sort tab in this mode (null: not a sorting key). */
export function keyAction(e: KeyLike, mode: SortMode = 'slot'): SortAction | null {
  if (e.altKey) return null
  const key = keyName(e)
  const history = historyKey(e, key)
  if (history || e.ctrlKey || e.metaKey) return history
  if (mode === 'bracket') return BRACKET_KEYS[key] ?? null
  if (mode === 'cull') return CULL_KEYS[key] ?? null
  if (key === 'w' || key === 'a' || key === 's' || key === 'd') return { kind: 'slot', slot: key satisfies SlotKey }
  return key === ' ' || key === 'ArrowRight' ? { kind: 'skip' } : null
}

// ---- A/B: what the two have in common ----

export interface ParamDiff {
  key: DiffKey
  a: string
  b: string
}

export type DiffKey = 'sampler' | 'cfg' | 'steps' | 'seed' | 'scheduler' | 'denoise' | 'model' | 'size'

/**
 * The same sampler written by different generators ("DPM++ 2M", "dpmpp_2m",
 * "k_euler_ancestral" vs "Euler a") compares equal; the text shown stays as written.
 */
export function samplerKey(value: string | null): string | null {
  if (!value) return null
  const s = value
    .toLowerCase()
    .trim()
    .replace(/\+\+/g, 'pp')
    .replace(/ancestral/g, 'a')
    .replace(/[\s_]+/g, '')
    .replace(/^k(?=euler|dpmpp|dpm|heun|lms)/, '')
  return s || null
}

type Field = { key: DiffKey; value: (g: GenerationInfo) => string | null; same?: (v: string | null) => string | null; generation: boolean }

const FIELDS: Field[] = [
  { key: 'sampler', value: (g) => g.sampler, same: samplerKey, generation: true },
  { key: 'cfg', value: (g) => g.cfg, generation: true },
  { key: 'steps', value: (g) => g.steps, generation: true },
  { key: 'seed', value: (g) => g.seed, generation: true },
  { key: 'scheduler', value: (g) => g.scheduler, same: samplerKey, generation: true },
  { key: 'denoise', value: (g) => g.denoise, generation: true },
  { key: 'model', value: (g) => (g.model ? shortModelName(g.model) : null), generation: false },
  { key: 'size', value: (g) => g.size, generation: false },
]

export interface Comparison {
  diffs: ParamDiff[]
  same: DiffKey[]
  /** Neither image carries generation parameters: "the same" would be a lie. */
  noParams: boolean
}

/** Only what differs between A and B, and the names of what is the same. */
export function compare(a: GenerationInfo, b: GenerationInfo): Comparison {
  const diffs: ParamDiff[] = []
  const same: DiffKey[] = []
  let params = 0
  for (const f of FIELDS) {
    const av = f.value(a)
    const bv = f.value(b)
    if (av === null && bv === null) continue
    if (f.generation) params += 1
    const key = f.same ?? ((v: string | null) => v)
    if (key(av) === key(bv)) same.push(f.key)
    else diffs.push({ key: f.key, a: av ?? '—', b: bv ?? '—' })
  }
  return { diffs, same, noParams: params === 0 }
}

/** Rounds A has held against newcomers. */
export const heldRounds = (duel: Duel): number => Math.max(0, duel.bIndex - duel.aIndex - 1)

/** A/B round shown as "n of m": B at index i is round i; n images need n - 1 rounds. */
export function round(index: number, total: number): { at: number; of: number } {
  const of = Math.max(0, total - 1)
  return { at: Math.min(Math.max(1, index), of), of }
}

export type FactKey = DiffKey | 'aesthetic'

/** The facts printed under each A/B picture, in reading order (the page words them). */
export function facts(image: SortImage): [FactKey, string][] {
  const g = image.gen
  const out: [FactKey, string | null][] = [
    ['sampler', g.sampler],
    ['cfg', g.cfg],
    ['steps', g.steps],
    ['seed', g.seed],
    ['model', g.model ? shortModelName(g.model) : null],
    ['size', g.size],
    ['aesthetic', image.aesthetic === null ? null : image.aesthetic.toFixed(1)],
  ]
  return out.filter((f): f is [FactKey, string] => f[1] !== null)
}

// ---- A/B: zooming both pictures to the same spot ----

/** How far "zoom both" magnifies. */
export const ZOOM_SCALE = 2.6

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** Where a picture of natural size nw×nh sits inside a bw×bh box when fitted whole (object-fit: contain). */
export function containedRect(nw: number, nh: number, bw: number, bh: number): Rect | null {
  if (!nw || !nh || !bw || !bh) return null
  const scale = Math.min(bw / nw, bh / nh)
  const width = nw * scale
  const height = nh * scale
  return { left: (bw - width) / 2, top: (bh - height) / 2, width, height }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** A pointer at (bx, by) in the box, as a spot on the picture itself (0–1 each way). */
export function spotOnPicture(nw: number, nh: number, bw: number, bh: number, bx: number, by: number): { x: number; y: number } {
  const r = containedRect(nw, nh, bw, bh)
  if (!r) return { x: clamp01(bx / (bw || 1)), y: clamp01(by / (bh || 1)) }
  return { x: clamp01((bx - r.left) / r.width), y: clamp01((by - r.top) / r.height) }
}

/** The transform origin (percent of the box) that zooms a picture onto that spot. */
export function zoomOrigin(spot: { x: number; y: number }, nw: number, nh: number, bw: number, bh: number): { x: number; y: number } {
  const r = containedRect(nw, nh, bw, bh)
  if (!r) return { x: spot.x * 100, y: spot.y * 100 }
  return { x: ((r.left + spot.x * r.width) / bw) * 100, y: ((r.top + spot.y * r.height) / bh) * 100 }
}

// ---- the pace of the keys ----

/** A key pressed sooner than `ms` after the last one that counted is ignored (0: never). */
export function tooSoon(lastAt: number | null, now: number, ms: number): boolean {
  return ms > 0 && lastAt !== null && now - lastAt < ms
}

const SPEED_WINDOW_MS = 30_000

/** Images per minute over the last half minute (null until there is enough to say). */
export function perMinute(stamps: readonly number[], now: number): number | null {
  const recent = stamps.filter((t) => now - t <= SPEED_WINDOW_MS)
  if (recent.length < 3) return null
  const span = Math.max(now - recent[0]!, 1000)
  return Math.round((recent.length / span) * 60_000)
}
