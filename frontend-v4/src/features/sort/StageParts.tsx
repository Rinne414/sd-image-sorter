import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { imageFileUrl, thumbnailUrl } from '../../api/client'
import { useLibraries } from '../../api/queries'
import { useT } from '../../i18n'
import { folderName } from '../../lib/paths'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { GenerationCard } from '../card/GenerationCard'
import { SortConfirm } from './SortConfirm'
import { perMinute, round } from './sortModes'
import { useSortPrefs } from './sortPrefs'
import { leftToSort, type LastAction, type SessionView, type SortError, type SortImage } from './sortSession'
import styles from './SortStage.module.css'
import { useSort } from './sortStore'
import { releaseButtonFocus, useSortKeys } from './useSortKeys'

// What every way to sort shows around its pictures: the header (where, pace,
// undo, sound, focus, details, new, end), the line saying what the last key
// did, the film strip of what comes next, and the end-of-sort question.

/** Thumbnails in the "up next" strip. */
const STRIP = 16

type Translate = ReturnType<typeof useT>

/** Focus mode is a layer; this says whether nothing has opened above it (null: focus is off). */
export const FocusTop = createContext<(() => boolean) | null>(null)

/** How long a key, side or stamp lights up after the last key. */
const LIT_MS = 320

/** What the last key lit (a slot, a side, a stamp), for a moment. `pick` reads it from the last action. */
export function useLit<K>(pick: (last: LastAction) => K | null): K | null {
  const last = useSort((s) => s.last)
  const [lit, setLit] = useState<K | null>(null)
  const pickRef = useRef(pick)
  pickRef.current = pick
  useEffect(() => {
    const key = last ? pickRef.current(last) : null
    if (key === null) return
    setLit(key)
    const timer = window.setTimeout(() => setLit(null), LIT_MS)
    return () => window.clearTimeout(timer)
  }, [last])
  return lit
}

/** Close a dialog, then take the focus it hands back off the button that opened it, so Space skips again. */
export function closeThen(close: () => void): void {
  close()
  requestAnimationFrame(releaseButtonFocus)
}

function lastText(t: Translate, last: LastAction, view: SessionView): string {
  switch (last.kind) {
    case 'skip':
      return t('sort.last.skipped')
    case 'redo':
      return t('sort.last.redone')
    case 'pick':
      return t(last.side === 'a' ? 'sort.last.pickA' : 'sort.last.pickB')
    case 'keep':
      return t('sort.last.kept')
    case 'reject':
      return t('sort.last.rejected')
    case 'undo':
      return t(last.what === 'skip' ? 'sort.last.undoneSkip' : last.what === 'slot' ? 'sort.last.undone' : 'sort.last.undoneOther')
    case 'slot': {
      const key = last.slot.toUpperCase()
      if (last.collect) return t('sort.last.collected', { key })
      const folder = folderName(view.folders[last.slot] ?? '')
      return t(view.operation === 'copy' ? 'sort.last.copied' : 'sort.last.moved', { key, folder })
    }
  }
}

function errorText(t: Translate, error: SortError, cooldownMs: number): string {
  if (error.kind === 'unset') return t('sort.error.unset', { key: error.slot.toUpperCase() })
  if (error.kind === 'nothing') return t('sort.error.nothing')
  if (error.kind === 'cooldown') return t('sort.error.cooldown', { ms: cooldownMs })
  return t('sort.error.failed', { reason: error.reason })
}

const HINT = { slot: 'sort.keysHint', bracket: 'sort.keysHintBracket', cull: 'sort.keysHintCull' } as const

/** The line under the picture: what the last key did, why a key did nothing, or the keys to use. */
export function StatusLine({ view }: { view: SessionView }) {
  const t = useT()
  const last = useSort((s) => s.last)
  const error = useSort((s) => s.error)
  const cooldownMs = useSortPrefs((s) => s.cooldownMs)
  const text = error ? errorText(t, error, cooldownMs) : last ? lastText(t, last, view) : t(HINT[view.mode])
  return (
    <p className={styles.status} data-tone={error ? 'error' : undefined} role={error ? 'alert' : 'status'} data-testid="sort-status">
      {text}
    </p>
  )
}

/** The name of the library the sort belongs to, when it is not the one open now. */
export function useOtherLibrary(view: SessionView): string | null {
  const t = useT()
  const current = useApp((s) => s.libraryId)
  const libraries = useLibraries()
  if (!view.libraryId || view.libraryId === current) return null
  const lib = libraries.data?.libraries.find((l) => l.id === view.libraryId)
  if (!lib) return view.libraryId
  return lib.is_default && lib.name === 'Main library' ? t('rail.mainLibrary') : lib.name
}

export function OtherLibraryNote({ view }: { view: SessionView }) {
  const t = useT()
  const name = useOtherLibrary(view)
  if (!name) return null
  return (
    <p className={styles.notice} role="note" data-testid="sort-other-library">
      {t('sort.otherLibrary', { name })}
    </p>
  )
}

/** Where the sort is, as the header says it: images, or A/B rounds. */
function position(t: Translate, view: SessionView): string {
  if (view.mode === 'bracket') return t('sort.round', round(view.index, view.total))
  return t('sort.pos', { at: Math.min(view.index + 1, view.total), total: view.total })
}

function Toggles({ single }: { single: boolean }) {
  const t = useT()
  const prefs = useSortPrefs()
  return (
    <>
      <button type="button" className="btn btn-ghost" aria-pressed={prefs.sound} onClick={() => prefs.setSound(!prefs.sound)} data-testid="sort-sound">
        {t('sort.sound')}
      </button>
      {single && (
        <button type="button" className="btn btn-ghost" aria-pressed={prefs.info} onClick={() => prefs.setInfo(!prefs.info)} title={`${t('sort.info')} (I)`} data-testid="sort-info">
          {t('sort.info')}
        </button>
      )}
      <button type="button" className="btn btn-ghost" aria-pressed={prefs.focus} onClick={() => prefs.setFocus(!prefs.focus)} title={t('sort.focusHint')} data-testid="sort-focus">
        {t(prefs.focus ? 'sort.focusExit' : 'sort.focus')}
      </button>
    </>
  )
}

function StageHead({ view, image, onEnd }: { view: SessionView; image: SortImage | null; onEnd: () => void }) {
  const t = useT()
  const busy = useSort((s) => s.sending || s.queue.length > 0)
  const stamps = useSort((s) => s.stamps)
  const press = useSort((s) => s.press)
  const pace = perMinute(stamps, Date.now())
  return (
    <header className={styles.head}>
      <span className={`${styles.pos} mono`} data-testid="sort-pos">
        {position(t, view)}
      </span>
      <span className={styles.name} title={image?.path}>
        {image?.filename}
      </span>
      {pace !== null && <span className={`${styles.pace} mono`}>{t('sort.pace', { n: pace })}</span>}
      <span className={styles.gap} aria-busy={busy || undefined} />
      {view.mode === 'slot' && <span className={styles.op}>{t(view.operation === 'copy' ? 'sort.copying' : 'sort.moving')}</span>}
      <button type="button" className="btn" onClick={() => press({ kind: 'undo' })} disabled={!view.canUndo} data-testid="sort-undo">
        <Icon name="undo" size={14} />
        {t('sort.undo')}
        <kbd>Backspace</kbd>
      </button>
      <button type="button" className="btn btn-ghost btn-icon" onClick={() => press({ kind: 'redo' })} disabled={!view.canRedo} aria-label={t('sort.redo')} title={`${t('sort.redo')} (Y)`}>
        <Icon name="redo" size={14} />
      </button>
      <span className={styles.rule} aria-hidden />
      <Toggles single={view.mode !== 'bracket'} />
      <span className={styles.rule} aria-hidden />
      <button type="button" className="btn btn-ghost" onClick={() => useSort.getState().openSetup(null)} data-testid="sort-new">
        {t('sort.newSort')}
      </button>
      <button type="button" className="btn btn-ghost" onClick={onEnd} data-testid="sort-end">
        {t('sort.end')}
      </button>
    </header>
  )
}

/** The big picture: the thumbnail holds the frame until the full image has loaded. */
export function Picture({ id, name, children }: { id: number; name: string; children?: ReactNode }) {
  const [ready, setReady] = useState(false)
  return (
    <div className={styles.picture} data-testid="sort-image" data-id={id}>
      <img className={styles.under} src={thumbnailUrl(id, 384)} alt="" draggable={false} />
      <img className={styles.full} data-ready={ready || undefined} src={imageFileUrl(id)} alt={name} draggable={false} onLoad={() => setReady(true)} />
      {children}
    </div>
  )
}

/** The next picture starts loading while this one is judged. */
function usePreload(ids: number[]): void {
  const next = ids[0]
  useEffect(() => {
    if (next !== undefined) new Image().src = imageFileUrl(next)
  }, [next])
}

interface StageProps {
  view: SessionView
  /** The picture whose name the header shows. */
  image: SortImage | null
  /** Shown in the details column when it is open (one picture at a time only). */
  infoId: number | null
  /** The picture(s). */
  children: ReactNode
  /** The row of keys under the pictures. */
  keys: ReactNode
  /** Dialogs of this way to sort. */
  dialogs?: ReactNode
}

/** A sort in progress, whichever way: header, pictures, status line, keys, what comes next. */
export function Stage({ view, image, infoId, children, keys, dialogs }: StageProps) {
  const t = useT()
  const [ending, setEnding] = useState(false)
  const info = useSortPrefs((s) => s.info) && infoId !== null
  const bumped = useSort((s) => s.bumped)
  useSortKeys(view.mode, useContext(FocusTop))
  const upNext = view.ids.slice(view.index + 1, view.index + 1 + STRIP)
  usePreload(upNext)
  const progress = view.total ? Math.min(100, (view.index / view.total) * 100) : 0
  return (
    <section className={styles.stage} data-testid="sort-session" data-mode={view.mode} onClick={releaseButtonFocus}>
      <StageHead view={view} image={image} onEnd={() => setEnding(true)} />
      <div className={styles.progress} aria-hidden>
        <span style={{ width: `${progress}%` }} />
      </div>
      <OtherLibraryNote view={view} />
      <div className={styles.middle} data-info={info || undefined}>
        <div className={styles.frame}>
          {children}
          {bumped > 0 && <span key={bumped} className={styles.bump} aria-hidden />}
        </div>
        {info && <GenerationCard id={infoId} variant="overlay" />}
      </div>
      <StatusLine view={view} />
      {keys}
      <div className={styles.strip} aria-label={t('sort.next')} data-testid="sort-next">
        {upNext.map((next) => (
          <span key={next} className={styles.thumb}>
            <img src={thumbnailUrl(next, 256)} alt="" loading="lazy" decoding="async" draggable={false} />
          </span>
        ))}
      </div>
      {dialogs}
      {ending && (
        <SortConfirm
          title={t('sort.end.title')}
          body={t('sort.end.body', { left: leftToSort(view) })}
          confirmLabel={t('sort.end.confirm')}
          cancelLabel={t('sort.end.keep')}
          onConfirm={() => useSort.getState().end()}
          onClose={() => closeThen(() => setEnding(false))}
        />
      )}
    </section>
  )
}
