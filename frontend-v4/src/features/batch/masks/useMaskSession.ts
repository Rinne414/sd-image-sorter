import { useCallback, useEffect, useRef, useState } from 'react'
import type { Raster } from '../../censor/raster'
import { tr } from '../../jobs/jobs'
import { useToasts } from '../../../ui/toasts'
import { autoMask, deleteMask, loadMask, saveMask, withEngine, type MaskEngine } from './maskApi'
import { coverage, pushState, redoState, undoState, type MaskAction, type MaskHistory, type MaskState } from './maskModel'

// One image's mask while the editor shows it: loading the picture's size and
// its saved mask, the changes with undo/redo, saving and removing.

type Loaded = { status: 'loading' } | { status: 'error'; reason: string } | { status: 'ready'; width: number; height: number; stored: Raster | null }

function naturalSize(imageId: number): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error(tr('dataset.masks.pictureFailed')))
    img.src = `/api/image-file/${imageId}`
  })
}

function useLoaded(imageId: number): Loaded {
  const [loaded, setLoaded] = useState<{ id: number; value: Loaded }>({ id: imageId, value: { status: 'loading' } })
  useEffect(() => {
    let live = true
    naturalSize(imageId)
      .then(async ({ width, height }) => ({ status: 'ready' as const, width, height, stored: await loadMask(imageId, width, height) }))
      .then(
        (value) => live && setLoaded({ id: imageId, value }),
        (error: Error) => live && setLoaded({ id: imageId, value: { status: 'error', reason: error.message } }),
      )
    return () => {
      live = false
    }
  }, [imageId])
  return loaded.id === imageId ? loaded.value : { status: 'loading' }
}

const EMPTY: MaskState = { base: null, actions: [] }
const toast = (text: string, tone: 'info' | 'error' = 'info') => useToasts.getState().push(text, tone)

export function useMaskSession(imageId: number) {
  const loaded = useLoaded(imageId)
  const [state, setState] = useState<MaskState>(EMPTY)
  const [saved, setSaved] = useState<MaskState>(EMPTY)
  const [hasMask, setHasMask] = useState(false)
  const [history, setHistory] = useState<MaskHistory>({ past: [], future: [] })
  const [busy, setBusy] = useState<'save' | 'auto' | 'remove' | null>(null)
  const [share, setShare] = useState(1)
  /** The image the state belongs to (it is set together with the state, after the load). */
  const [readyFor, setReadyFor] = useState<number | null>(null)
  const pixels = useRef<Raster | null>(null)
  const current = useRef(imageId)
  current.current = imageId
  // The state as last rendered, for changes that arrive later (an automatic mask).
  const latest = useRef(state)
  latest.current = state

  useEffect(() => {
    if (loaded.status !== 'ready') return
    const start = { base: loaded.stored, actions: [] }
    setState(start)
    setSaved(start)
    setHasMask(loaded.stored !== null)
    setHistory({ past: [], future: [] })
    // A ready load is always the current image's (useLoaded says "loading" for any other).
    setReadyFor(imageId)
  }, [loaded, imageId])

  const onPixels = useCallback((mask: Raster) => {
    pixels.current = mask
    setShare(coverage(mask))
  }, [])

  const change = (next: MaskState) => {
    const before = latest.current
    latest.current = next
    setHistory((h) => pushState(h, before))
    setState(next)
  }
  const act = (action: MaskAction) => change({ ...latest.current, actions: [...latest.current.actions, action] })

  const undo = () => {
    const back = undoState(history, state)
    if (!back) return
    setHistory(back.history)
    setState(back.state)
  }
  const redo = () => {
    const again = redoState(history, state)
    if (!again) return
    setHistory(again.history)
    setState(again.state)
  }

  const save = async (): Promise<boolean> => {
    if (!pixels.current || busy) return false
    setBusy('save')
    try {
      await saveMask(imageId, pixels.current)
      setSaved(state)
      setHasMask(true)
      toast(tr('dataset.masks.saved'))
      return true
    } catch (error) {
      toast(tr('dataset.masks.saveFailed', { reason: (error as Error).message }), 'error')
      return false
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('remove')
    try {
      await deleteMask(imageId)
      setHistory({ past: [], future: [] })
      setState(EMPTY)
      setSaved(EMPTY)
      setHasMask(false)
      toast(tr('dataset.masks.removed'))
    } catch (error) {
      toast(tr('error.generic', { reason: (error as Error).message }), 'error')
    } finally {
      setBusy(null)
    }
  }

  /** An automatic mask to start from (not saved: the user reviews it). A model download runs first when needed. */
  const auto = async (engine: MaskEngine) => {
    if (loaded.status !== 'ready') return
    const { width, height } = loaded
    const target = imageId
    const run = () => {
      setBusy('auto')
      autoMask(target, engine, width, height)
        .then(
          (base) => {
            if (current.current === target) change({ base, actions: [] })
          },
          (error: Error) => toast(tr('dataset.masks.autoFailed', { reason: error.message }), 'error'),
        )
        .finally(() => setBusy(null))
    }
    setBusy('auto')
    const how = await withEngine(engine, run)
    if (how !== 'ran') setBusy(null)
  }

  const ready = loaded.status === 'ready' && readyFor === imageId ? loaded : null
  return { loaded, ready, state, dirty: state !== saved, hasMask, share, busy, history, onPixels, act, change, undo, redo, save, remove, auto }
}

export type MaskSession = ReturnType<typeof useMaskSession>
