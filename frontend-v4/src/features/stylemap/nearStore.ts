import { create } from 'zustand'
import { ApiError } from '../../api/client'
import { rawJson } from '../../api/raw'
import { useApp } from '../../state/store'
import { tr } from '../jobs/jobs'
import { useArtistPrefs } from '../tools/artist/artistPrefs'
import { cachedMapQuery } from './mapRequest'
import { mapOnScreen, refresh, setPreview } from './mapStore'
import { failureNote, fileProblem, NEAR_K, noVectorNote, outsideAllNote, placeNote, ringsOf, slowNote, SLOW_MODEL_MS, type Note, type Ring } from './lookups'
import { getScene } from './sceneHandle'
import type { NearAnswer, Space } from './types'

// "The pictures most like this one", for a dropped file (POST /query, the
// picture is never stored) or a library picture (GET /near, its stored
// vector). The answer is drawn twice: rings on the map and a list in the side
// panel. A new map (space, filter, the UMAP fit) asks again for the same
// picture. The "find a picture" box adds one marker ring of its own.

export type NearSource = { kind: 'file'; file: File; url: string } | { kind: 'library'; id: number }

interface NearState {
  source: NearSource | null
  result: NearAnswer | null
  resultSig: string | null
  note: Note | null
  /** The row the camera was turned to ('query' for the picture itself). */
  active: number | 'query' | null
  /** The found picture's ring, for the map it was found on. */
  marker: { ring: Ring; sig: string } | null
  /** A file is being dragged over the page. */
  dragging: boolean
}

export const useNear = create<NearState>(() => ({ source: null, result: null, resultSig: null, note: null, active: null, marker: null, dragging: false }))

const set = (patch: Partial<NearState>) => useNear.setState(patch)
const get = () => useNear.getState()

let seq = 0
let controller: AbortController | null = null
let slowTimer = 0
let runSig: string | null = null
let focusQuery = false
/** The map a lost-map answer already rebuilt once: a server that keeps losing it gets an error, not a loop. */
let rebuilt: string | null = null

function abortRun(): void {
  seq += 1
  controller?.abort()
  controller = null
  window.clearTimeout(slowTimer)
  slowTimer = 0
}

function dropUrl(): void {
  const source = get().source
  if (source?.kind === 'file') URL.revokeObjectURL(source.url)
}

/** Every ring the map draws now: the lookup's, then the found picture's. */
export function ringsNow(state: NearState = get(), signature: string | null = mapOnScreen()?.signature ?? null): Ring[] {
  const rings = state.result && state.resultSig === signature ? ringsOf(state.result) : []
  if (state.marker && state.marker.sig === signature) rings.push(state.marker.ring)
  return rings
}

function fly(xyz: [number, number, number], id?: number): void {
  getScene()?.flyTo(xyz, id === undefined ? {} : { id })
}

/** Ask what is most like a dropped file. */
export function lookupFile(file: File): void {
  const problem = fileProblem(file)
  if (problem) {
    abortRun()
    set({ result: null, resultSig: null, note: problem })
    return
  }
  dropUrl()
  set({ source: { kind: 'file', file, url: URL.createObjectURL(file) }, active: null })
  focusQuery = true
  rebuilt = null
  void run()
}

/** Ask what is most like a library picture (the camera turns to its own dot). */
export function lookupLibrary(id: number): void {
  dropUrl()
  set({ source: { kind: 'library', id }, active: null })
  focusQuery = true
  rebuilt = null
  void run()
}

/** The map has nothing for a library picture: say why, with the way out. */
export function explainLibrary(id: number, space: Space, outside: boolean): void {
  abortRun()
  dropUrl()
  set({ source: { kind: 'library', id }, result: null, resultSig: null, active: null, note: outside ? outsideAllNote : noVectorNote(space) })
}

export function clearNear(): void {
  abortRun()
  dropUrl()
  set({ source: null, result: null, resultSig: null, note: null, active: null, marker: null })
}

export const setDragging = (dragging: boolean): void => {
  if (get().dragging !== dragging) set({ dragging })
}

/** The found picture's ring (null removes it). */
export function setMarker(ring: Ring | null): void {
  const sig = mapOnScreen()?.signature
  set({ marker: ring && sig ? { ring, sig } : null })
}

/** Turn the camera to a row's dot and show its picture. */
export function pickRow(id: number | 'query', position: [number, number, number] | null): void {
  set({ active: id })
  if (position) fly(position, id === 'query' ? undefined : id)
  if (id !== 'query') setPreview({ id, members: 1 })
}

/**
 * A new map is on screen: a lookup of the same map keeps its answer; another
 * map asks again for the same picture (its coordinates changed).
 */
export function nearMapChanged(signature: string | null): void {
  const s = get()
  if (s.marker && s.marker.sig !== signature) set({ marker: null })
  if (!signature) {
    // No map now (another space is loading): an answer still on its way belongs to the old one.
    abortRun()
    runSig = null
    if (s.result) set({ result: null, resultSig: null })
    return
  }
  if (!s.source || signature === s.resultSig || signature === runSig) return
  void run()
}

async function fetchAnswer(source: NearSource, query: string, signal: AbortSignal): Promise<NearAnswer> {
  if (source.kind === 'library') return rawJson<NearAnswer>('GET', `/api/style-map/near?${query}&image_id=${source.id}`, { signal })
  const form = new FormData()
  form.append('file', source.file, source.file.name || 'upload')
  return rawJson<NearAnswer>('POST', `/api/style-map/query?${query}`, { form, signal })
}

/** One lookup; a map the server lost is rebuilt once and asked again. */
async function run(): Promise<void> {
  const map = mapOnScreen()
  const source = get().source
  if (!map || !source) return
  abortRun()
  const mine = seq
  runSig = map.signature
  controller = new AbortController()
  set({ note: { key: 'stylemap.near.working', tone: 'busy' }, result: null, resultSig: null })
  const space = map.scope.space
  if (source.kind === 'file' && space !== 'clip') {
    slowTimer = window.setTimeout(() => {
      if (mine === seq) set({ note: slowNote(space) })
    }, SLOW_MODEL_MS)
  }
  const gpu = source.kind === 'file' && space !== 'clip' ? useArtistPrefs.getState().useGpu : null
  const extra: Record<string, string | number | boolean> = { k: NEAR_K }
  if (gpu !== null) extra.use_gpu = gpu
  try {
    const answer = await fetchAnswer(source, cachedMapQuery(map.scope, map.mapId, extra), controller.signal)
    if (mine !== seq) return
    if (answer?.status === 'not_started') {
      if (rebuilt === map.signature) throw new Error(tr('stylemap.lostMap'))
      rebuilt = map.signature
      window.clearTimeout(slowTimer)
      runSig = null
      // The new map asks again (nearMapChanged); without a new map, ask once more here.
      await refresh()
      if (mine === seq) await run()
      return
    }
    if (answer?.status === 'no_vector') {
      set({ note: noVectorNote(space) })
      return
    }
    accept(answer, map.signature, source)
  } catch (error) {
    if (mine !== seq || (error as Error).name === 'AbortError') return
    const note = error instanceof ApiError ? failureNote(error.status, error.message) : failureNote(0, (error as Error).message)
    set({ note, result: null, resultSig: null })
    focusQuery = false
  } finally {
    if (mine === seq) {
      window.clearTimeout(slowTimer)
      slowTimer = 0
      runSig = null
    }
  }
}

function accept(answer: NearAnswer, signature: string, source: NearSource): void {
  const note = source.kind === 'library' ? placeNote(answer.self) : null
  set({ result: answer, resultSig: signature, note })
  if (focusQuery && answer.query) {
    set({ active: 'query' })
    fly([answer.query.x, answer.query.y, answer.query.z])
  }
  if (source.kind === 'library') setPreview({ id: source.id, members: 1 })
  focusQuery = false
}

// Another library: the picture asked about (and its answer) belong to the one left.
useApp.subscribe((s, prev) => {
  if (s.libraryId !== prev.libraryId) clearNear()
})
