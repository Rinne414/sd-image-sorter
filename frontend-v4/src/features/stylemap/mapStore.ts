import { create } from 'zustand'
import { api, unwrap } from '../../api/client'
import type { components } from '../../api/schema'
import { rawJson } from '../../api/raw'
import { useApp } from '../../state/store'
import { toSelectionBody } from '../../lib/selectionBody'
import { installThen } from '../jobs/installJob'
import { tr } from '../jobs/jobs'
import { currentLibraryParams } from '../library/params'
import { clearPin, usePinned } from '../library/pinnedSet'
import { modelConfig, useArtistPrefs } from '../tools/artist/artistPrefs'
import { cachedMapQuery, isFiltered, mapQuery, mapSignature, scopeParams, type MapScope, type ModelChoice } from './mapRequest'
import { loadPrefs, writePref } from './prefs'
import { hasPoints, layoutPending } from './status'
import type { AxesAnswer, ColorBy, ColorsAnswer, LayoutStatusAnswer, PointsAnswer, Region, RegionsAnswer, Space, UmapState } from './types'

// The Style Map page's state and its requests (docs/API.md "Style Map"):
//   library filter -> POST /api/images/selection-token -> GET /points
//   points.umap queued | computing -> GET /layout-status every few seconds;
//   ready or not_started -> points again.
// Colours, regions and axis meanings are asked for by the map handle the
// points answer carried (`map_id`). A `not_started` answer (the server lost
// the map) rebuilds it once per user action, never in a loop. Answers that
// arrive after the map changed (or the page closed) are dropped.

const LAYOUT_POLL_MS = 3000
const UMAP_CARD = 'style-map-umap'

type TokenBody = components['schemas']['SelectionTokenRequest']

export type LoadState = 'idle' | 'loading' | 'ok' | 'error'

export interface Preview {
  id: number
  members: number
}

interface MapState {
  space: Space
  colorBy: ColorBy
  landmarksOn: boolean
  labelsOn: boolean
  axesOpen: boolean
  /** The library filter the map draws, as words (empty: the whole library). */
  filterText: string
  filtered: boolean
  token: string | null
  points: PointsAnswer | null
  umap: UmapState | null
  loading: boolean
  error: string | null
  colors: ColorsAnswer | null
  colorsState: LoadState
  regions: Region[]
  axes: { state: LoadState; data: AxesAnswer | null; layout: 'pca' | 'umap' }
  /** The picture the side panel shows (the hovered dot, or a row the user picked). */
  preview: Preview | null
}

const prefs = loadPrefs()

export const useMap = create<MapState>(() => ({
  space: prefs.space,
  colorBy: prefs.colorBy,
  landmarksOn: prefs.landmarks,
  labelsOn: prefs.labels,
  axesOpen: false,
  filterText: '',
  filtered: false,
  token: null,
  points: null,
  umap: null,
  loading: false,
  error: null,
  colors: null,
  colorsState: 'idle',
  regions: [],
  axes: { state: 'idle', data: null, layout: 'pca' },
  preview: null,
}))

let seq = 0
let colorSeq = 0
let layoutTimer = 0
let open = false
const retried = { colors: false, regions: false, axes: false }

const set = (patch: Partial<MapState>) => useMap.setState(patch)
const get = () => useMap.getState()

/** The Style Finder model the Kaloscope map reads; a half-filled local setting reads the official one. */
export function modelChoice(): ModelChoice {
  const config = modelConfig(useArtistPrefs.getState())
  return config ? { model_source: config.model_source, model_path: config.model_path } : { model_source: 'huggingface', model_path: null }
}

export function currentScope(): MapScope {
  return { space: get().space, token: get().token, model: modelChoice() }
}

/** The map on screen and its handle; null while there is none. */
export function mapOnScreen(): { scope: MapScope; mapId: string; method: string; signature: string } | null {
  const points = get().points
  if (!hasPoints(points) || !points?.map_id) return null
  const method = points.method === 'umap' ? 'umap' : 'pca'
  return { scope: currentScope(), mapId: points.map_id, method, signature: mapSignature(get().space, points.map_id, points.method) }
}

/** The user's own action re-arms the one rebuild a lost map gets. */
function armRetries(): void {
  retried.colors = false
  retried.regions = false
  retried.axes = false
}

function clearLayoutTimer(): void {
  window.clearTimeout(layoutTimer)
  layoutTimer = 0
}

function filterWords(): string {
  const s = useApp.getState()
  // A set of pictures sent from the map is the whole filter while it is shown.
  const pin = usePinned.getState().pin
  if (pin) return tr('stylemap.pin.title', { n: pin.count })
  const parts = [s.queryText.trim(), s.scope.folder ?? '', ...s.scope.generators]
  if (s.scope.favorites) parts.push('★')
  return parts.filter(Boolean).join(' · ')
}

async function scopeToken(): Promise<{ token: string | null; filtered: boolean }> {
  const params = scopeParams(currentLibraryParams())
  if (!isFiltered(params)) return { token: null, filtered: false }
  const body = toSelectionBody(params) as unknown as TokenBody
  const answer = unwrap<{ selection_token: string }>(await api.POST('/api/images/selection-token', { body }))
  return { token: answer.selection_token, filtered: true }
}

/** Ask for the map again (`force`: recompute even when cached). */
export async function refresh(force = false): Promise<void> {
  if (!open) return
  const mine = ++seq
  clearLayoutTimer()
  set({ loading: true })
  try {
    const { token, filtered } = await scopeToken()
    if (mine !== seq) return
    set({ token, filtered, filterText: filtered ? filterWords() : '' })
    const query = mapQuery(currentScope(), force ? { refresh: true } : {})
    const points = await rawJson<PointsAnswer>('GET', `/api/style-map/points?${query}`)
    if (mine !== seq) return
    applyPoints(points)
  } catch (error) {
    // Nothing that was loading for this map will arrive now.
    if (mine === seq) set({ error: (error as Error).message, colorsState: get().colorsState === 'loading' ? 'error' : get().colorsState, axes: get().axes.state === 'loading' ? { ...get().axes, state: 'error' } : get().axes })
  } finally {
    if (mine === seq) set({ loading: false })
  }
}

function applyPoints(points: PointsAnswer): void {
  const same = get().colors?.by === get().colorBy
  // Colours are per picture: the last answer stays on the new ids until the fresh one lands (no grey flash).
  set({ points, umap: points.umap ?? null, error: null, regions: [], colors: hasPoints(points) && same ? get().colors : null })
  scheduleLayoutPoll(points.umap?.status)
  if (!hasPoints(points)) {
    set({ colorsState: 'idle', axes: { state: 'idle', data: null, layout: 'pca' } })
    return
  }
  void loadColors()
  void loadRegions()
  void loadAxes()
}

function scheduleLayoutPoll(status: string | undefined): void {
  clearLayoutTimer()
  if (open && layoutPending(status)) layoutTimer = window.setTimeout(() => void pollLayout(), LAYOUT_POLL_MS)
}

async function pollLayout(): Promise<void> {
  layoutTimer = 0
  if (!open) return
  const mine = seq
  try {
    const status = await rawJson<LayoutStatusAnswer>('GET', `/api/style-map/layout-status?${mapQuery(currentScope())}`)
    if (mine !== seq || !open) return
    const umap = status?.umap ?? {}
    // ready: fetch the UMAP coordinates; not_started: the server lost the inputs, a points call rebuilds them.
    if (umap.status === 'ready' || umap.status === 'not_started') {
      await refresh()
      return
    }
    set({ umap })
    scheduleLayoutPoll(umap.status)
  } catch {
    if (mine === seq) scheduleLayoutPoll('queued')
  }
}

function mapRequest(extra: Record<string, string | number | boolean> = {}): string | null {
  const map = mapOnScreen()
  return map ? cachedMapQuery(map.scope, map.mapId, extra) : null
}

/** The chosen field's values for the map on screen (never refetches points for a colour change). */
async function loadColors(): Promise<void> {
  const mine = seq
  const mineColor = ++colorSeq
  const by = get().colorBy
  const query = mapRequest({ by })
  if (!query) return
  set({ colorsState: 'loading' })
  try {
    const body = await rawJson<ColorsAnswer>('GET', `/api/style-map/colors?${query}`)
    if (mine !== seq || mineColor !== colorSeq || !open) return
    if (body?.status === 'not_started') {
      set({ colors: null })
      if (!retried.colors) {
        retried.colors = true
        await refresh()
        return
      }
      throw new Error('not_started')
    }
    if (body?.status !== 'ok') throw new Error(String(body?.status ?? 'no answer'))
    set({ colors: body, colorsState: 'ok' })
  } catch {
    if (mine === seq && mineColor === colorSeq) set({ colors: null, colorsState: 'error' })
  }
}

async function loadRegions(): Promise<void> {
  const mine = seq
  const query = mapRequest()
  if (!query) return
  try {
    const body = await rawJson<RegionsAnswer>('GET', `/api/style-map/regions?${query}`)
    if (mine !== seq || !open) return
    if (body?.status === 'not_started') {
      if (!retried.regions) {
        retried.regions = true
        await refresh()
      }
      return
    }
    // Regions of another layout (the UMAP fit finished in between): the layout poll asks again.
    const method = get().points?.method
    if (body?.method && method && body.method !== method) return
    set({ regions: body?.regions ?? [] })
  } catch {
    // the map stays usable without landmarks; the next map asks again
  }
}

async function loadAxes(): Promise<void> {
  const mine = seq
  const map = mapOnScreen()
  const layout = map?.method === 'umap' ? 'umap' : 'pca'
  if (!map) {
    set({ axes: { state: 'idle', data: null, layout } })
    return
  }
  set({ axes: { state: 'loading', data: null, layout } })
  try {
    const body = await rawJson<AxesAnswer>('GET', `/api/style-map/axes?${cachedMapQuery(map.scope, map.mapId, { layout })}`)
    if (mine !== seq || !open) return
    if (body?.status === 'not_started') {
      if (!retried.axes) {
        retried.axes = true
        await refresh()
        return
      }
      throw new Error('not_started')
    }
    if (body?.status === 'empty') set({ axes: { state: 'idle', data: null, layout } })
    else if (body?.status === 'ok') set({ axes: { state: 'ok', data: body, layout } })
    else throw new Error(String(body?.status ?? 'no answer'))
  } catch {
    if (mine === seq) set({ axes: { state: 'error', data: null, layout } })
  }
}

// ---- the user's actions ----------------------------------------------------

/** The page opened: read the map. */
export function openMap(): void {
  open = true
  armRetries()
  void refresh()
}

/** The page closed: answers still in flight are dropped, polling stops. */
export function closeMap(): void {
  open = false
  seq += 1
  clearLayoutTimer()
  // The next visit reads a fresh map (the library or its filter may change meanwhile).
  set({ preview: null, axesOpen: false, points: null, umap: null, colors: null, colorsState: 'idle', regions: [], loading: false, error: null, axes: { state: 'idle', data: null, layout: 'pca' } })
}

export function setSpace(space: Space): void {
  if (space === get().space) return
  writePref('space', space)
  set({ space, points: null, umap: null, colors: null, colorsState: 'idle', regions: [], axes: { state: 'idle', data: null, layout: 'pca' }, preview: null })
  armRetries()
  void refresh()
}

export function setColorBy(colorBy: ColorBy): void {
  if (colorBy === get().colorBy) return
  writePref('colorBy', colorBy)
  // Grey until the new field's answer lands: the dots never show one field while the select names another.
  set({ colorBy, colors: null })
  armRetries()
  if (hasPoints(get().points)) void loadColors()
}

export function retryColors(): void {
  retried.colors = false
  set({ colors: null })
  void loadColors()
}

export function retryAxes(): void {
  retried.axes = false
  void loadAxes()
}

/** Retry a failed UMAP fit (and anything else this map lost). */
export function retryLayout(): void {
  armRetries()
  void refresh(true)
}

export function setLandmarks(on: boolean): void {
  writePref('landmarks', on)
  set({ landmarksOn: on })
}

export function setLabels(on: boolean): void {
  writePref('labels', on)
  set({ labelsOn: on })
}

export const setAxesOpen = (axesOpen: boolean): void => set({ axesOpen })

export const setPreview = (preview: Preview | null): void => set({ preview })

/** Map the whole library: the library's own filter is cleared (the library page shows everything too). */
export function showWholeLibrary(): void {
  clearPin()
  const app = useApp.getState()
  app.setQueryText('')
  app.setScope({ generators: [], folder: null, favorites: false })
  armRetries()
  void refresh()
}

/** Install UMAP (one click, as a job in the drawer); the map is laid out again when it is done. */
export async function installUmap(): Promise<boolean> {
  return installThen({ card: UMAP_CARD, variant: null, label: tr('stylemap.layout.installLabel') }, () => {
    armRetries()
    void refresh(true)
  })
}

/** A job that changed what the map draws ended (the index, the similarity index). */
export function afterIndexJob(): void {
  armRetries()
  void refresh(true)
}

// Another library while the map is open (Ctrl K "Switch to…"): the dots on
// screen are the old library's pictures. Answers still on their way are
// dropped and the new library's map is read. (The picks, My axes and the
// nearest-pictures card follow the library on their own.)
useApp.subscribe((s, prev) => {
  if (s.libraryId === prev.libraryId || !open) return
  closeMap()
  openMap()
})
