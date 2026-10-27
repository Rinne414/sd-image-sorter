import { create } from 'zustand'
import { rawJson } from '../../api/raw'
import { useApp } from '../../state/store'
import { tr } from '../jobs/jobs'
import {
  canApply,
  customLayout,
  parseStored,
  readDefinitions,
  requestKey,
  storageKey,
  storedText,
  withName,
  withoutAxis,
  withoutPicture,
  withPicked,
  type CustomAnswer,
  type CustomLayout,
  type CustomStatus,
  type Definitions,
  type End,
} from './customAxes'
import { mapQuery } from './mapRequest'
import { mapOnScreen, refresh, useMap } from './mapStore'
import { usePicks } from './pickStore'
import type { AxisName, PointsAnswer } from './types'

// "My axes" on the page: the definitions of the current library, the
// request, and the layout it gives the points on screen. While the axes are
// applied the map is laid out along them (MapCanvas draws `shown`) and what
// describes the ORIGINAL layout (the region landmarks, the model's axis
// meanings) is hidden, never shown stale. A lost map (not_started) is
// rebuilt once per user action, never in a loop. Answers that arrive after
// the definitions or the map changed are dropped.

const CACHE_SIZE = 4

/** The user's layout, for one points answer (MapCanvas draws it only on those points). */
export interface CustomShown extends CustomLayout {
  points: PointsAnswer
}

export type AxesTab = 'model' | 'custom'

interface CustomState {
  libraryId: string
  defs: Definitions
  /** The user pressed Apply (kept with the definitions: the next visit lays the map out again). */
  applied: boolean
  status: CustomStatus
  /** Why the last Apply failed, in words. */
  error: string
  result: CustomAnswer | null
  shown: CustomShown | null
  /** The axis card's tab. */
  tab: AxesTab
  /** Empty axes the user unfolded (X is open at the start). */
  expanded: readonly AxisName[]
}

function readStored(libraryId: string): { defs: Definitions; applied: boolean } {
  try {
    return parseStored(localStorage.getItem(storageKey(libraryId)))
  } catch {
    return parseStored(null)
  }
}

const startLibrary = useApp.getState().libraryId

export const useCustom = create<CustomState>(() => ({
  libraryId: startLibrary,
  ...readStored(startLibrary),
  status: 'idle',
  error: '',
  result: null,
  shown: null,
  tab: 'model',
  expanded: ['x'],
}))

const set = (patch: Partial<CustomState>) => useCustom.setState(patch)
const get = () => useCustom.getState()

let seq = 0
let retried = false
const cache = new Map<string, CustomAnswer>()

/** The user's layout on the points the map shows now; null while the model's layout is shown. */
export function useCustomShown(): CustomShown | null {
  const shown = useCustom((s) => s.shown)
  const points = useMap((s) => s.points)
  return shown && shown.points === points ? shown : null
}

function save(): void {
  const { libraryId, defs, applied } = get()
  try {
    localStorage.setItem(storageKey(libraryId), storedText(defs, applied))
  } catch {
    // private window or blocked storage: the definitions hold for this visit
  }
}

/** The definitions belong to one library: another library's are read before anything is shown or saved. */
function syncLibrary(): boolean {
  const libraryId = useApp.getState().libraryId
  if (libraryId === get().libraryId) return false
  seq += 1
  cache.clear()
  set({ libraryId, ...readStored(libraryId), status: 'idle', error: '', result: null, shown: null })
  return true
}

function change(defs: Definitions): void {
  syncLibrary()
  set({ defs })
  save()
}

/** The map on screen and what the request names. */
function currentRequest(): { query: string; body: { space: string; map_id: string; layout: string }; points: PointsAnswer } | null {
  const map = mapOnScreen()
  const points = useMap.getState().points
  if (!map || !points) return null
  const layout = map.method === 'umap' ? 'umap' : 'pca'
  return { query: mapQuery({ ...map.scope, token: null }), body: { space: map.scope.space, map_id: map.mapId, layout }, points }
}

/** Lay the points out along an answer; false when it is for other points. */
function show(answer: CustomAnswer, points: PointsAnswer): boolean {
  const drawn = customLayout(points.points ?? [], points.points_layout, answer)
  if (!drawn) return false
  set({ shown: { ...drawn, points }, result: answer, status: 'ok', error: '' })
  return true
}

/** The server lost the map (or its layout): ask for the map again once; the new map asks again. */
async function rebuildOnce(mine: number, reason: string): Promise<void> {
  if (retried) throw new Error(reason)
  retried = true
  await refresh()
  // A new map started its own request; without one, this one ends here.
  if (mine === seq) throw new Error(reason)
}

async function run(): Promise<void> {
  const request = currentRequest()
  if (!request) return
  const { axes } = readDefinitions(get().defs)
  const mine = ++seq
  const key = requestKey(request.body.map_id, request.body.layout, request.body.space, axes)
  const known = cache.get(key)
  if (known && show(known, request.points)) return
  // While it is asked for, the last layout of the user's axes (if any) stays on screen.
  set({ status: 'working', error: '' })
  try {
    const answer = await rawJson<CustomAnswer>('POST', `/api/style-map/custom-axes?${request.query}`, { body: { ...request.body, axes } })
    if (mine !== seq) return
    if (answer?.status === 'not_started' || answer?.status === 'layout_not_ready') {
      await rebuildOnce(mine, tr('stylemap.lostMap'))
      return
    }
    if (answer?.status === 'empty') {
      set({ status: 'ok', result: answer, shown: null })
      return
    }
    if (answer?.status !== 'ok') throw new Error(String(answer?.status ?? 'no answer'))
    if (!show(answer, request.points)) {
      await rebuildOnce(mine, tr('stylemap.custom.layoutChanged'))
      return
    }
    cache.set(key, answer)
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  } catch (error) {
    if (mine !== seq) return
    set({ status: 'error', error: (error as Error).message || String(error), result: null, shown: null })
  }
}

// ---- the user's actions ----------------------------------------------------

export const setAxesTab = (tab: AxesTab): void => set({ tab })

export function unfoldAxis(axis: AxisName): void {
  if (!get().expanded.includes(axis)) set({ expanded: [...get().expanded, axis] })
}

/** Add the dots picked on the map to one end of an axis. */
export function addPicked(axis: AxisName, end: End): void {
  const picked = usePicks.getState().picked
  if (picked.size === 0) return
  change(withPicked(get().defs, axis, end, picked))
}

/** Typing a name does not lay the map out again (the axis labels follow at once). */
export function setEndName(axis: AxisName, end: End, name: string): void {
  change(withName(get().defs, axis, end, name))
}

export function removePicture(axis: AxisName, end: End, id: number): void {
  change(withoutPicture(get().defs, axis, end, id))
  followEdit()
}

export function clearAxis(axis: AxisName): void {
  change(withoutAxis(get().defs, axis))
  set({ expanded: get().expanded.filter((a) => a !== axis || axis === 'x') })
  followEdit()
}

/**
 * Pictures taken away while the axes are on: the map follows what is left
 * and, with no complete axis left, goes back to the model's layout.
 */
function followEdit(): void {
  if (!get().applied) return
  retried = false
  if (!canApply(get().defs)) revertCustom()
  else void run()
}

/** The user pressed Apply. */
export function applyCustom(): void {
  syncLibrary()
  const { axes, problems } = readDefinitions(get().defs)
  if (problems.length || !Object.keys(axes).length) {
    set({ status: 'error', error: tr(problems.length ? 'stylemap.custom.needTwo' : 'stylemap.custom.needOne') })
    return
  }
  retried = false
  set({ applied: true })
  save()
  void run()
}

/** Back to the layout the model computed. */
export function revertCustom(): void {
  seq += 1
  syncLibrary()
  set({ applied: false, status: 'idle', error: '', result: null, shown: null })
  save()
}

/** A new points answer (or none): lay it out along the stored axes again. */
function customMapChanged(): void {
  syncLibrary()
  const { applied, result } = get()
  const points = useMap.getState().points
  if (!applied || !points || !mapOnScreen()) {
    // No map now (another space is loading, the page closed): an answer still on its way belongs to the old one.
    if (get().shown) set({ shown: null })
    if (!mapOnScreen()) seq += 1
    if (get().status === 'working') set({ status: 'idle' })
    return
  }
  // The same pictures as before (a finished UMAP fit, coming back to the page): the last layout stays on screen meanwhile.
  if (!(result && result.status === 'ok' && show(result, points))) set({ shown: null })
  void run()
}

useMap.subscribe((s, prev) => {
  if (s.points !== prev.points) customMapChanged()
})

useApp.subscribe((s, prev) => {
  if (s.libraryId !== prev.libraryId) syncLibrary()
})
