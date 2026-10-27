import { create } from 'zustand'
import { rawJson } from '../../api/raw'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { mapQuery } from './mapRequest'
import { mapOnScreen } from './mapStore'
import type { StyleMapScene } from './scene'
import { getScene } from './sceneHandle'
import { idsAt, keptOnMap, pickedDots, pickFlags, toggled, withMembers, type DragMode } from './selection'
import type { MembersAnswer } from './types'

// The dots picked on the map (a box, a lasso, Shift + click) and every
// picture they stand for. A dot can stand for several near-identical
// pictures, so a pick is expanded through POST /api/style-map/members
// (skipped when no picked dot is merged) before the bar under the map sends
// it anywhere. Picks are kept by picture id: a redrawn map (another layout,
// the user's own axes, a refreshed index) keeps the picks still on it.

export type PickStatus = 'idle' | 'expanding' | 'ready'

interface PickState {
  /** What a plain left-drag does (Shift + drag always draws a box). */
  mode: DragMode
  /** The picked dots, by the picture id each dot is drawn for. */
  picked: ReadonlySet<number>
  /** Every picture of the pick (the dots and the pictures merged into them); empty while expanding. */
  ids: number[]
  status: PickStatus
}

const EMPTY: ReadonlySet<number> = new Set()

export const usePicks = create<PickState>(() => ({ mode: 'rotate', picked: EMPTY, ids: [], status: 'idle' }))

let seq = 0

const set = (patch: Partial<PickState>) => usePicks.setState(patch)

export const setDragMode = (mode: DragMode): void => set({ mode })

/** Forget the pick and take the marks off the dots. */
export function clearPicks(): void {
  seq += 1
  set({ picked: EMPTY, ids: [], status: 'idle' })
  getScene()?.setSelected(null)
}

/** Every picture behind the picked dots; null when the server no longer has this map. */
async function expand(scene: StyleMapScene, picked: ReadonlySet<number>): Promise<number[] | null> {
  const { reps, merged } = pickedDots(scene.ids, scene.members, picked)
  // Nothing merged behind the picked dots: the dots are the pictures.
  if (!merged) return reps
  const map = mapOnScreen()
  if (!map) return null
  const body = { space: map.scope.space, map_id: map.mapId, rep_ids: reps }
  const answer = await rawJson<MembersAnswer>('POST', `/api/style-map/members?${mapQuery({ ...map.scope, token: null })}`, { body })
  return answer?.status === 'ok' ? withMembers(reps, answer.ids ?? []) : null
}

/** Make `picked` the pick: mark the dots, then find every picture they stand for. */
async function commit(picked: ReadonlySet<number>): Promise<void> {
  const scene = getScene()
  if (!scene || picked.size === 0) {
    clearPicks()
    return
  }
  const mine = ++seq
  set({ picked, ids: [], status: 'expanding' })
  scene.setSelected(pickFlags(scene.ids, picked))
  try {
    const ids = await expand(scene, picked)
    if (mine !== seq) return
    if (ids === null) {
      useToasts.getState().push(tr('stylemap.sel.stale'), 'info')
      clearPicks()
      return
    }
    set({ ids, status: 'ready' })
  } catch (error) {
    if (mine !== seq) return
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
    clearPicks()
  }
}

/** A box or a lasso: these dots (indices into the scene) become the pick. */
export function pickIndices(indices: readonly number[]): void {
  const scene = getScene()
  if (!scene) return
  void commit(idsAt(indices, scene.ids))
}

/** Shift + click (or a click while box or lasso is chosen): one dot in or out of the pick. */
export function toggleIndex(index: number): void {
  const scene = getScene()
  const id = scene?.ids[index]
  if (!scene || id === undefined) return
  void commit(toggled(usePicks.getState().picked, id))
}

/**
 * The scene drew a new set of dots: keep the picks that are still on it. An
 * empty scene (the next map is still loading, the page just opened) decides
 * nothing: the picks wait for the dots.
 */
export function picksMapChanged(scene: StyleMapScene): void {
  const { picked } = usePicks.getState()
  if (picked.size === 0 || scene.count === 0) return
  const kept = keptOnMap(picked, scene.ids)
  if (kept.size === picked.size) {
    scene.setSelected(pickFlags(scene.ids, picked))
    return
  }
  void commit(kept)
}

// Picks name pictures of one library.
useApp.subscribe((s, prev) => {
  if (s.libraryId !== prev.libraryId) clearPicks()
})
