import { useEffect, useState } from 'react'
import { imageFileUrl, thumbnailUrl } from '../../api/client'
import { useT } from '../../i18n'
import { folderName, parentFolder } from '../../lib/paths'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { SlotFolderDialog } from './SlotFolderDialog'
import { SortConfirm } from './SortConfirm'
import { SLOT_KEYS, leftToSort, upNow, type LastAction, type SessionView, type SlotKey, type SortError, type SortImage } from './sortSession'
import { loadSetup, saveSetup, withFolder } from './savedSetup'
import styles from './SortStage.module.css'
import { useSort } from './sortStore'
import { releaseButtonFocus, useSortKeys } from './useSortKeys'

/** Thumbnails in the "up next" strip. */
const STRIP = 16
/** How long a slot lights up after an image went into it. */
const FLASH_MS = 320

type Translate = ReturnType<typeof useT>

function lastText(t: Translate, last: LastAction, view: SessionView): string {
  if (last.kind === 'skip') return t('sort.last.skipped')
  if (last.kind === 'redo') return t('sort.last.redone')
  if (last.kind === 'undo') return t(last.what === 'skip' ? 'sort.last.undoneSkip' : 'sort.last.undone')
  const key = last.slot.toUpperCase()
  if (last.collect) return t('sort.last.collected', { key })
  const folder = folderName(view.folders[last.slot] ?? '')
  return t(view.operation === 'copy' ? 'sort.last.copied' : 'sort.last.moved', { key, folder })
}

function errorText(t: Translate, error: SortError): string {
  if (error.kind === 'unset') return t('sort.error.unset', { key: error.slot.toUpperCase() })
  if (error.kind === 'nothing') return t('sort.error.nothing')
  return t('sort.error.failed', { reason: error.reason })
}

/** Close a dialog, then take the focus it hands back off the button that opened it, so Space skips again. */
function closeThen(close: () => void): void {
  close()
  requestAnimationFrame(releaseButtonFocus)
}

/** The slot an image just went into, lit for a moment. */
function useFlash(last: LastAction | null): SlotKey | null {
  const [flash, setFlash] = useState<SlotKey | null>(null)
  useEffect(() => {
    if (last?.kind !== 'slot') return
    setFlash(last.slot)
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [last])
  return flash
}

/** A sort in progress: the image, the four keys with their folders and counts, what comes next. */
export function SortStage({ view }: { view: SessionView }) {
  const t = useT()
  const last = useSort((s) => s.last)
  const error = useSort((s) => s.error)
  const [choosing, setChoosing] = useState<SlotKey | null>(null)
  const [ending, setEnding] = useState(false)
  const flash = useFlash(last)
  useSortKeys()

  const now = upNow(view)
  const upNext = view.ids.slice(view.index + 1, view.index + 1 + STRIP)
  const status = error ? errorText(t, error) : last ? lastText(t, last, view) : t('sort.keysHint')

  // The next picture starts loading while this one is judged.
  useEffect(() => {
    const next = view.ids[view.index + 1]
    if (next !== undefined) new Image().src = imageFileUrl(next)
  }, [view.ids, view.index])

  return (
    <section className={styles.stage} data-testid="sort-session" onClick={releaseButtonFocus}>
      <StageHead view={view} image={now?.image ?? null} onEnd={() => setEnding(true)} />
      <div className={styles.frame}>{now && <Picture key={now.id} id={now.id} name={now.image?.filename ?? ''} />}</div>
      <p className={styles.status} data-tone={error ? 'error' : undefined} role={error ? 'alert' : 'status'} data-testid="sort-status">
        {status}
      </p>
      <div className={styles.slots}>
        {SLOT_KEYS.map((slot) => (
          <SlotButton key={slot} slot={slot} view={view} lit={flash === slot} onChoose={() => setChoosing(slot)} />
        ))}
        <button
          type="button"
          className={styles.skip}
          onClick={() => useSort.getState().press({ kind: 'skip' })}
          data-testid="sort-skip"
        >
          <kbd className={styles.cap}>{t('sort.spaceKey')}</kbd>
          <span className={styles.slotName}>{t('sort.skip')}</span>
          <span className={`${styles.slotCount} mono`}>{view.skipped}</span>
        </button>
      </div>
      <div className={styles.strip} aria-label={t('sort.next')} data-testid="sort-next">
        {upNext.map((next) => (
          <span key={next} className={styles.thumb}>
            <img src={thumbnailUrl(next, 256)} alt="" loading="lazy" decoding="async" draggable={false} />
          </span>
        ))}
      </div>
      {choosing && <ChangeFolder slot={choosing} view={view} image={now?.image ?? null} onClose={() => closeThen(() => setChoosing(null))} />}
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

function StageHead({ view, image, onEnd }: { view: SessionView; image: SortImage | null; onEnd: () => void }) {
  const t = useT()
  const busy = useSort((s) => s.sending || s.queue.length > 0)
  const press = useSort((s) => s.press)
  return (
    <header className={styles.head}>
      <span className={`${styles.pos} mono`} data-testid="sort-pos">
        {t('sort.pos', { at: view.index + 1, total: view.total })}
      </span>
      <span className={styles.name} title={image?.path}>
        {image?.filename}
      </span>
      <span className={styles.gap} aria-busy={busy || undefined} />
      <span className={styles.op}>{t(view.operation === 'copy' ? 'sort.copying' : 'sort.moving')}</span>
      <button type="button" className="btn" onClick={() => press({ kind: 'undo' })} disabled={!view.canUndo} data-testid="sort-undo">
        <Icon name="undo" size={14} />
        {t('sort.undo')}
        <kbd>Backspace</kbd>
      </button>
      <button type="button" className="btn btn-ghost btn-icon" onClick={() => press({ kind: 'redo' })} disabled={!view.canRedo} aria-label={t('sort.redo')} title={`${t('sort.redo')} (Y)`}>
        <Icon name="redo" size={14} />
      </button>
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
function Picture({ id, name }: { id: number; name: string }) {
  const [ready, setReady] = useState(false)
  return (
    <div className={styles.picture} data-testid="sort-image" data-id={id}>
      <img className={styles.under} src={thumbnailUrl(id, 384)} alt="" draggable={false} />
      <img className={styles.full} data-ready={ready || undefined} src={imageFileUrl(id)} alt={name} draggable={false} onLoad={() => setReady(true)} />
    </div>
  )
}

interface SlotProps {
  slot: SlotKey
  view: SessionView
  lit: boolean
  onChoose: () => void
}

/** One key: click it like pressing it; a key without a folder asks for one. */
function SlotButton({ slot, view, lit, onChoose }: SlotProps) {
  const t = useT()
  const key = slot.toUpperCase()
  const folder = view.folders[slot] ?? null
  const collection = view.collections[slot] ?? null
  const usable = folder !== null || collection !== null
  const name = folder ? folderName(folder) : collection ? `#${collection}` : t('sort.slot.unset')
  const label = usable ? t('sort.slot.send', { key, folder: folder ?? name }) : t('sort.slot.pickFolder', { key })
  return (
    <div className={styles.slotWrap} data-lit={lit || undefined} data-unset={!usable || undefined} data-count={view.counts[slot] ?? 0}>
      <button
        type="button"
        className={styles.slot}
        onClick={() => (usable ? useSort.getState().press({ kind: 'slot', slot }) : onChoose())}
        title={label}
        aria-label={label}
        data-testid={`sort-slot-${slot}`}
      >
        <kbd className={styles.cap}>{key}</kbd>
        <span className={styles.slotName}>{name}</span>
        {usable && <span className={`${styles.slotCount} mono`}>{view.counts[slot] ?? 0}</span>}
      </button>
      {usable && collection === null && (
        <button
          type="button"
          className={styles.slotEdit}
          onClick={onChoose}
          aria-label={`${key} · ${t('sort.slot.change')}`}
          title={t('sort.slot.change')}
          data-testid={`sort-change-${slot}`}
        >
          <Icon name="folder" size={13} />
        </button>
      )}
    </div>
  )
}

/** Point a key at another folder mid-sort; the next sort in this library starts with it too. */
function ChangeFolder({ slot, view, image, onClose }: { slot: SlotKey; view: SessionView; image: SortImage | null; onClose: () => void }) {
  const libraryId = useApp((s) => s.libraryId)
  const choose = async (path: string) => {
    const ok = await useSort.getState().setSlotFolder(slot, path)
    if (ok) saveSetup(libraryId, withFolder(loadSetup(libraryId), slot, path))
    return ok
  }
  const source = image?.path ? parentFolder(image.path) : null
  return <SlotFolderDialog slot={slot} current={view.folders[slot] ?? null} sourceFolder={source} onChoose={choose} onClose={onClose} />
}
