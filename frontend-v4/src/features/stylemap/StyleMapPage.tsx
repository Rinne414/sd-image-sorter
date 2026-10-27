import { useEffect, useRef } from 'react'
import { isTypingTarget } from '../../lib/format'
import { claimFileDrops } from '../../ui/dropClaim'
import { layerCount } from '../../ui/layers'
import { useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { takeHandoff, useHandoff } from '../tools/handoff'
import { followRunningIndex } from './indexJob'
import { MapCanvas } from './MapCanvas'
import { MapLightbox } from './MapLightbox'
import { afterIndexJob, closeMap, mapOnScreen, openMap, useMap } from './mapStore'
import { explainLibrary, lookupFile, lookupLibrary, nearMapChanged, setDragging } from './nearStore'
import { clearPicks, usePicks } from './pickStore'
import { SidePanel } from './SidePanel'
import styles from './StyleMap.module.css'
import { SubBar } from './SubBar'
import { Toolbar } from './Toolbar'

/**
 * 画风地图 (#/tools/stylemap): the library as a 3-D cloud of style vectors.
 * The toolbar picks what places the pictures and what colours the dots and
 * builds the index; the bar under it says what the map covers and finds a
 * picture; the side panel previews, lists the nearest pictures of a picture
 * and explains the map.
 */
export function StyleMapPage() {
  useEffect(() => {
    openMap()
    void followRunningIndex()
    return closeMap
  }, [])
  useJobEnds()
  useNearFollowsMap()
  useLibraryHandoff()
  usePageDrop()
  useEscapeClearsPicks()

  return (
    <div className={styles.page} data-testid="stylemap-page">
      <Toolbar />
      <SubBar />
      <div className={styles.body}>
        <MapCanvas />
        <SidePanel />
      </div>
      <MapLightbox />
    </div>
  )
}

/** The map is drawn again when a job that changed it ends (the index; the similarity index for the CLIP map). */
function useJobEnds(): void {
  const seen = useRef(new Set<string>())
  useEffect(() => {
    const check = (jobs: ReturnType<typeof useJobs.getState>['jobs']) => {
      for (const job of jobs) {
        if (!isFinished(job.progress.status) || seen.current.has(job.id)) continue
        seen.current.add(job.id)
        const space = useMap.getState().space
        // Only a job that stored something changes the map (a stop or failure with nothing new does not).
        const changed = job.progress.succeeded > 0
        if (changed && (job.kind === 'stylemap' || (job.kind === 'embed' && space === 'clip'))) afterIndexJob()
      }
    }
    // Jobs that ended before the page opened are not news.
    for (const job of useJobs.getState().jobs) if (isFinished(job.progress.status)) seen.current.add(job.id)
    return useJobs.subscribe((s) => check(s.jobs))
  }, [])
}

/** A new map is on screen: the nearest-pictures card asks again for its picture. */
function useNearFollowsMap(): void {
  const points = useMap((s) => s.points)
  useEffect(() => {
    nearMapChanged(mapOnScreen()?.signature ?? null)
  }, [points])
}

/** "Send to tool ▸ Style Map" from the library: show where that picture is and what is most like it. */
function useLibraryHandoff(): void {
  const pending = useHandoff((s) => s.pending)
  const points = useMap((s) => s.points)
  const loading = useMap((s) => s.loading)
  const waiting = useRef<number | null>(null)
  useEffect(() => {
    if (pending?.tool !== 'stylemap') return
    const ids = takeHandoff('stylemap')
    if (ids?.length) waiting.current = ids[0]!
  }, [pending])
  useEffect(() => {
    const id = waiting.current
    if (id === null || loading || !points) return
    waiting.current = null
    if (mapOnScreen()) lookupLibrary(id)
    else explainLibrary(id, useMap.getState().space, points.status === 'empty' || (points.total_images ?? 0) === 0)
  }, [points, loading, pending])
}

/**
 * Esc clears the picked dots. It reaches the page only when nothing floats
 * above it (ui/layers.ts takes Esc for the top layer first: a menu, the axis
 * card, a shape being drawn), and a field being typed in keeps its own Esc.
 */
function useEscapeClearsPicks(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || layerCount() > 0 || isTypingTarget(e.target)) return
      if (usePicks.getState().picked.size === 0) return
      e.preventDefault()
      clearPicks()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')

/**
 * A picture file dropped anywhere on the page asks for its nearest pictures
 * (the library's own drop import stands aside while the map is shown).
 */
function usePageDrop(): void {
  useEffect(() => {
    const release = claimFileDrops()
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth += 1
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = mapOnScreen() && layerCount() === 0 ? 'copy' : 'none'
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const file = e.dataTransfer?.files?.[0]
      // A dialog or the lightbox on top is not the map.
      if (file && mapOnScreen() && layerCount() === 0) lookupFile(file)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      release()
      setDragging(false)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])
}
