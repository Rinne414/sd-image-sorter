import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useT } from '../../../i18n'
import { useLayer } from '../../../ui/layers'
import { Icon } from '../../../ui/Icon'
import { focusKind } from '../../censor/keys'
import { MaskCanvas } from './MaskCanvas'
import styles from './MaskEditor.module.css'
import type { MaskEngine } from './maskApi'
import type { MaskTool } from './maskModel'
import { MaskTools, type ZoomCommand } from './MaskTools'
import { useMaskSession } from './useMaskSession'

// The training-mask editor: one Library image at a time (the batch's Library
// images in order), painted over with a keep and a leave-out brush. It floats
// above the step as a layer; Esc closes it (asking first when a change is not saved).

export const useMaskEditor = create<{ open: { ids: number[]; at: number } | null }>(() => ({ open: null }))

export function openMaskEditor(ids: readonly number[], imageId: number): void {
  if (ids.length === 0) return
  useMaskEditor.setState({ open: { ids: [...ids], at: Math.max(0, ids.indexOf(imageId)) } })
}

const closeEditor = () => useMaskEditor.setState({ open: null })

export function MaskEditor({ names }: { names: ReadonlyMap<number, string> }) {
  const open = useMaskEditor((s) => s.open)
  if (!open) return null
  return <Editor key={open.ids.join(',')} ids={open.ids} start={open.at} names={names} />
}

/** Brush sizes in image pixels. */
const SIZE_MIN = 2
const SIZE_MAX = 800
const SIZE_STEP = 1.25

interface EditorProps {
  ids: number[]
  start: number
  names: ReadonlyMap<number, string>
}

function Editor({ ids, start, names }: EditorProps) {
  const t = useT()
  const [at, setAt] = useState(start)
  const imageId = ids[at] as number
  const session = useMaskSession(imageId)
  const [tool, setTool] = useState<MaskTool>('drop')
  const [size, setSize] = useState(48)
  const [engine, setEngine] = useState<MaskEngine>('rembg')
  const [command, setCommand] = useState<ZoomCommand | null>(null)
  const [panKey, setPanKey] = useState(false)
  const [leaving, setLeaving] = useState<(() => void) | null>(null)
  const zoom = (kind: ZoomCommand['kind']) => setCommand((c) => ({ kind, n: (c?.n ?? 0) + 1 }))

  /** Leave this image (close, or go to another): ask first when its change is not saved. */
  const leave = (then: () => void) => (session.dirty ? setLeaving(() => then) : then())
  const go = (step: 1 | -1) => {
    const next = at + step
    if (next >= 0 && next < ids.length) leave(() => setAt(next))
  }
  const isTop = useLayer(true, () => (leaving ? setLeaving(null) : leave(closeEditor)))

  useEditorKeys({
    isTop,
    tool: setTool,
    size: (grow) => setSize((s) => Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, grow ? s * SIZE_STEP : s / SIZE_STEP)))),
    undo: session.undo,
    redo: session.redo,
    save: () => void session.save(),
    go,
    fit: () => zoom('fit'),
    pan: setPanKey,
  })

  const ready = session.ready
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={t('dataset.masks.editorTitle')} data-testid="mask-editor">
      <header className={styles.bar}>
        <strong className={styles.title}>{t('dataset.masks.editorTitle')}</strong>
        <span className={`${styles.pos} mono`}>{`${at + 1} / ${ids.length}`}</span>
        <span className={styles.name} title={names.get(imageId)}>
          {names.get(imageId) ?? `#${imageId}`}
        </span>
        <span className={styles.state} data-testid="mask-state" data-has-mask={session.hasMask || undefined} data-dirty={session.dirty || undefined}>
          {session.dirty ? t('dataset.masks.stateDirty') : session.hasMask ? t('dataset.masks.stateSaved') : t('dataset.masks.stateNone')}
        </span>
        <span className={styles.gap} />
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => go(-1)} disabled={at === 0} aria-label={t('dataset.masks.prev')} title={t('dataset.masks.prev')}>
          <Icon name="left" size={14} />
        </button>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => go(1)} disabled={at === ids.length - 1} aria-label={t('dataset.masks.next')} title={t('dataset.masks.next')}>
          <Icon name="right" size={14} />
        </button>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => leave(closeEditor)} aria-label={t('dataset.masks.close')} title={t('dataset.masks.close')} data-testid="mask-close">
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className={styles.body}>
        <div className={styles.stage}>
          {ready ? (
            <MaskCanvas
              imageId={imageId}
              width={ready.width}
              height={ready.height}
              state={session.state}
              tool={tool}
              size={size}
              panKey={panKey}
              onStroke={session.act}
              onPixels={session.onPixels}
              command={command}
            />
          ) : (
            <p className={styles.note}>{session.loaded.status === 'error' ? t('dataset.masks.loadFailedText', { reason: session.loaded.reason }) : t('grid.loading')}</p>
          )}
          {leaving && <LeaveBar session={session} onDone={() => setLeaving(null)} then={leaving} />}
        </div>
        <MaskTools session={session} tool={tool} onTool={setTool} size={size} onSize={setSize} engine={engine} onEngine={setEngine} onZoom={zoom} ready={!!ready} />
      </div>
    </div>
  )
}

function LeaveBar({ session, onDone, then }: { session: ReturnType<typeof useMaskSession>; onDone: () => void; then: () => void }) {
  const t = useT()
  const keepRef = useRef<HTMLButtonElement>(null)
  useEffect(() => keepRef.current?.focus(), [])
  return (
    <div className={styles.leave} role="alertdialog" aria-label={t('dataset.masks.unsaved')} data-testid="mask-leave">
      <span>{t('dataset.masks.unsaved')}</span>
      <button
        type="button"
        className="btn btn-primary"
        onClick={async () => {
          if (await session.save()) {
            onDone()
            then()
          }
        }}
      >
        {t('dataset.masks.saveAndGo')}
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => {
          onDone()
          then()
        }}
        data-testid="mask-discard"
      >
        {t('dataset.masks.discard')}
      </button>
      <button ref={keepRef} type="button" className="btn btn-ghost" onClick={onDone}>
        {t('dataset.masks.keepEditing')}
      </button>
    </div>
  )
}

interface KeyHandlers {
  isTop: () => boolean
  tool: (tool: MaskTool) => void
  size: (grow: boolean) => void
  undo: () => void
  redo: () => void
  save: () => void
  go: (step: 1 | -1) => void
  fit: () => void
  pan: (on: boolean) => void
}

/** B keep, E leave out, [ ] size, Ctrl+Z / Ctrl+Shift+Z undo / redo, Ctrl+S save, A / D previous / next, 0 fit, Space pans. */
function useEditorKeys(handlers: KeyHandlers): void {
  const ref = useRef(handlers)
  ref.current = handlers
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const h = ref.current
      if (!h.isTop() || e.altKey) return
      const key = e.key.toLowerCase()
      if (e.ctrlKey || e.metaKey) {
        const act = key === 'z' ? (e.shiftKey ? h.redo : h.undo) : key === 'y' ? h.redo : key === 's' ? h.save : null
        if (!act) return
        e.preventDefault()
        act()
        return
      }
      if (focusKind(e.target) === 'text') return
      const plain: Record<string, () => void> = {
        b: () => h.tool('keep'),
        e: () => h.tool('drop'),
        '[': () => h.size(false),
        ']': () => h.size(true),
        a: () => h.go(-1),
        d: () => h.go(1),
        '0': h.fit,
        ' ': () => h.pan(true),
      }
      const act = plain[key]
      if (!act) return
      e.preventDefault()
      act()
    }
    const onUp = (e: KeyboardEvent) => e.key === ' ' && ref.current.pan(false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])
}
