import type { MessageKey, Params } from '../../i18n'
import { AXIS_NAMES, type AxisName, type PointRow } from './types'

// "My axes": the user decides what an axis means. Each of x / y / z takes two
// groups of example pictures (end A, end B) and an optional name per end;
// POST /api/style-map/custom-axes lays the map out along "more like B than
// A". Pure rules here: the definitions (stored per library as picture ids,
// so another space recomputes from the same examples), what can be applied,
// how an answer moves the dots, and what the card says about it. Ported from
// the classic page (frontend/js/style-map/custom-axes.js, state.js showCustom).
//
// The definitions are the user's work, not a setting: they live under
// `sd-stylemap-custom-axes:<library>` (the classic page's key and format, so
// both interfaces share them) and "Reset all settings" leaves them alone
// (lib/resetSettings.ts lists only preferences; customAxes.test.ts pins it).

export type End = 'a' | 'b'

/** Each axis's name on screen. */
export const AXIS_TITLE: Readonly<Record<AxisName, MessageKey>> = { x: 'stylemap.axes.x', y: 'stylemap.axes.y', z: 'stylemap.axes.z' }

export interface AxisDef {
  a: number[]
  b: number[]
  nameA: string
  nameB: string
}

export type Definitions = Record<AxisName, AxisDef>

/** At least this many usable pictures at each end. */
export const MIN_EXAMPLES = 2
export const NAME_MAX = 40
export const STORAGE_PREFIX = 'sd-stylemap-custom-axes:'

export const storageKey = (libraryId: string): string => `${STORAGE_PREFIX}${libraryId || 'main'}`

const emptyAxis = (): AxisDef => ({ a: [], b: [], nameA: '', nameB: '' })

export function emptyDefinitions(): Definitions {
  return { x: emptyAxis(), y: emptyAxis(), z: emptyAxis() }
}

const cleanIds = (list: unknown): number[] =>
  [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]

const cleanName = (value: unknown): string => String(value ?? '').slice(0, NAME_MAX)

/** Only the ids and names survive a reload; anything else in storage is dropped. */
export function sanitizeDefinitions(raw: unknown): Definitions {
  const out = emptyDefinitions()
  const source = (raw ?? {}) as Partial<Record<AxisName, Record<string, unknown> | null>>
  for (const axis of AXIS_NAMES) {
    const entry = source[axis]
    if (!entry || typeof entry !== 'object') continue
    out[axis] = { a: cleanIds(entry.a), b: cleanIds(entry.b), nameA: cleanName(entry.nameA), nameB: cleanName(entry.nameB) }
  }
  return out
}

export interface Stored {
  defs: Definitions
  applied: boolean
}

/** What the definitions and the applied state read from storage (a damaged value reads as nothing). */
export function parseStored(text: string | null): Stored {
  const saved = readJson(text)
  const defs = sanitizeDefinitions(saved?.axes)
  return { defs, applied: saved?.applied === true && canApply(defs) }
}

function readJson(text: string | null): { applied?: unknown; axes?: unknown } | null {
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' ? (value as { applied?: unknown; axes?: unknown }) : null
  } catch {
    return null
  }
}

/** The stored text (the classic page's format). */
export const storedText = (defs: Definitions, applied: boolean): string => JSON.stringify({ v: 1, applied, axes: defs })

export interface ReadDefinitions {
  /** The complete axes, as the request names them. */
  axes: Partial<Record<AxisName, { a: number[]; b: number[] }>>
  /** The names of the complete axes' two ends. */
  names: Partial<Record<AxisName, { a: string; b: string }>>
  /** Axes that are started but one-sided or short of examples. */
  problems: AxisName[]
}

export function readDefinitions(defs: Definitions): ReadDefinitions {
  const axes: ReadDefinitions['axes'] = {}
  const names: ReadDefinitions['names'] = {}
  const problems: AxisName[] = []
  for (const axis of AXIS_NAMES) {
    const d = defs[axis]
    if (!d.a.length && !d.b.length) continue
    if (d.a.length < MIN_EXAMPLES || d.b.length < MIN_EXAMPLES) {
      problems.push(axis)
      continue
    }
    axes[axis] = { a: d.a, b: d.b }
    names[axis] = { a: d.nameA.trim(), b: d.nameB.trim() }
  }
  return { axes, names, problems }
}

/** True when at least one axis has two ends with enough pictures (the Apply button needs it). */
export const canApply = (defs: Definitions): boolean => Object.keys(readDefinitions(defs).axes).length > 0

/** A started axis is shown open; an empty one only when the user asked for it. */
export const isStarted = (def: AxisDef): boolean => def.a.length > 0 || def.b.length > 0

/** Picked pictures added to one end (a picture can be at one end of an axis only). */
export function withPicked(defs: Definitions, axis: AxisName, end: End, picked: Iterable<number>): Definitions {
  const mine = new Set(defs[axis][end])
  for (const id of picked) mine.add(id)
  const other: End = end === 'a' ? 'b' : 'a'
  const next = { ...defs[axis], [end]: [...mine], [other]: defs[axis][other].filter((id) => !mine.has(id)) }
  return { ...defs, [axis]: next }
}

export function withoutPicture(defs: Definitions, axis: AxisName, end: End, id: number): Definitions {
  return { ...defs, [axis]: { ...defs[axis], [end]: defs[axis][end].filter((value) => value !== id) } }
}

export function withName(defs: Definitions, axis: AxisName, end: End, name: string): Definitions {
  return { ...defs, [axis]: { ...defs[axis], [end === 'a' ? 'nameA' : 'nameB']: name.slice(0, NAME_MAX) } }
}

export const withoutAxis = (defs: Definitions, axis: AxisName): Definitions => ({ ...defs, [axis]: emptyAxis() })

// ---- the answer -------------------------------------------------------------

export interface CustomAxisReport {
  applied?: boolean
  reason?: string | null
  missing_ids?: number[]
  agree?: number
  total?: number
  separable?: boolean
}

export interface CustomAnswer {
  /** ok, empty, not_started (the map was lost) or layout_not_ready (the UMAP fit is gone). */
  status: string
  layout?: string
  ids?: number[]
  coords?: number[][]
  axes?: Partial<Record<AxisName, CustomAxisReport | null>>
  warnings?: { code?: string; axes?: string[]; cos?: number }[]
}

export type Xyz = [number, number, number]

/** The dots moved along the user's axes, and how a lookup's position finds its moved dot. */
export interface CustomLayout {
  rows: PointRow[]
  /** A position the server computed (a ring, a found picture) -> its dot's shown position; null: not a dot. */
  remap: (xyz: Xyz, id?: number) => Xyz | null
}

const dotKey = (x: number, y: number, z: number): string => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`

/**
 * The points on screen laid out by an answer; null when the answer is for
 * other points (a refresh in between), so it is never half drawn. A lookup
 * names a dot by its picture id when it knows it, else by its coordinates
 * (a picture merged into a dot shares the dot's rounded position).
 */
export function customLayout(rows: readonly PointRow[], layout: readonly string[] | undefined, answer: CustomAnswer): CustomLayout | null {
  const names = layout && layout.length ? layout : ['id', 'x', 'y', 'z', 'members']
  const col = (name: string, fallback: number) => {
    const at = names.indexOf(name)
    return at >= 0 ? at : fallback
  }
  const [cid, cx, cy, cz] = [col('id', 0), col('x', 1), col('y', 2), col('z', 3)]
  const ids = answer.ids ?? []
  const coords = answer.coords ?? []
  if (ids.length !== rows.length || coords.length !== rows.length) return null
  if (rows.some((row, i) => row[cid] !== ids[i])) return null
  const byId = new Map<number, Xyz>()
  const byDot = new Map<string, Xyz>()
  const moved = rows.map((row, i) => {
    const c = coords[i]!
    const to: Xyz = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]
    byId.set(row[cid]!, to)
    const key = dotKey(row[cx] ?? 0, row[cy] ?? 0, row[cz] ?? 0)
    if (!byDot.has(key)) byDot.set(key, to)
    const next = [...row]
    next[cx] = to[0]
    next[cy] = to[1]
    next[cz] = to[2]
    return next
  })
  const remap = (xyz: Xyz, id?: number): Xyz | null => (id !== undefined && byId.get(id)) || byDot.get(dotKey(...xyz)) || null
  return { rows: moved, remap }
}

// ---- what the card says ------------------------------------------------------

export type NoteTone = 'busy' | 'ok' | 'warn' | 'error' | 'info'

/** One state line; `axis` / `pair` name axes the caller writes in words. */
export interface CustomNote {
  key: MessageKey
  params?: Params
  axis?: AxisName
  pair?: [AxisName, AxisName]
  tone: NoteTone
}

export type CustomStatus = 'idle' | 'working' | 'ok' | 'error'

const isAxis = (value: unknown): value is AxisName => AXIS_NAMES.includes(value as AxisName)

/** The state lines: working, error, short ends, and what the last answer says about the examples. */
export function customNotes(state: { status: CustomStatus; error: string; applied: boolean; result: CustomAnswer | null; defs: Definitions }): CustomNote[] {
  const notes: CustomNote[] = []
  if (state.status === 'working') notes.push({ key: 'stylemap.custom.working', tone: 'busy' })
  if (state.status === 'error' && state.error) notes.push({ key: 'stylemap.custom.error', params: { error: state.error }, tone: 'error' })
  if (readDefinitions(state.defs).problems.length && state.status !== 'error') notes.push({ key: 'stylemap.custom.needTwo', tone: 'warn' })
  const result = state.result
  if (!state.applied || result?.status !== 'ok') return notes
  notes.push({ key: 'stylemap.custom.applied', tone: 'ok' })
  for (const axis of AXIS_NAMES) {
    const info = result.axes?.[axis]
    if (!info) continue
    if (!info.applied) {
      const identical = info.reason === 'identical_ends'
      notes.push({ key: identical ? 'stylemap.custom.identical' : 'stylemap.custom.tooFew', axis, tone: 'warn' })
    } else if (!info.separable) {
      notes.push({ key: 'stylemap.custom.notSeparable', axis, params: { agree: info.agree ?? 0, total: info.total ?? 0 }, tone: 'warn' })
    }
    if (info.missing_ids?.length) notes.push({ key: 'stylemap.custom.missing', axis, params: { n: info.missing_ids.length }, tone: 'warn' })
  }
  for (const warning of result.warnings ?? []) {
    const [a, b] = warning.axes ?? []
    if (isAxis(a) && isAxis(b)) notes.push({ key: 'stylemap.custom.parallel', pair: [a, b], tone: 'warn' })
  }
  notes.push({ key: 'stylemap.custom.hidden', tone: 'info' })
  return notes
}

/** A request's identity: the same map, layout, space and definitions are never asked twice. */
export const requestKey = (mapId: string, layout: string, space: string, axes: ReadDefinitions['axes']): string => JSON.stringify([mapId, layout, space, axes])
