import { useState } from 'react'
import { useT } from '../../i18n'
import { folderName, parentFolder } from '../../lib/paths'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { loadSetup, saveSetup, withFolder } from './savedSetup'
import { SlotFolderDialog } from './SlotFolderDialog'
import { SLOT_KEYS, upNow, type SessionView, type SlotKey, type SortImage } from './sortSession'
import styles from './SortStage.module.css'
import { useSort } from './sortStore'
import { closeThen, Picture, Stage, useLit } from './StageParts'

/** A WASD sort in progress: the image, the four keys with their folders and counts, what comes next. */
export function SortStage({ view }: { view: SessionView }) {
  const t = useT()
  const [choosing, setChoosing] = useState<SlotKey | null>(null)
  const lit = useLit((last) => (last.kind === 'slot' ? last.slot : null))
  const now = upNow(view)

  const keys = (
    <div className={styles.slots}>
      {SLOT_KEYS.map((slot) => (
        <SlotButton key={slot} slot={slot} view={view} lit={lit === slot} onChoose={() => setChoosing(slot)} />
      ))}
      <button type="button" className={styles.skip} onClick={() => useSort.getState().press({ kind: 'skip' })} data-testid="sort-skip">
        <kbd className={styles.cap}>{t('sort.spaceKey')}</kbd>
        <span className={styles.slotName}>{t('sort.skip')}</span>
        <span className={`${styles.slotCount} mono`}>{view.skipped}</span>
      </button>
    </div>
  )
  const dialog = choosing && (
    <ChangeFolder slot={choosing} view={view} image={now?.image ?? null} onClose={() => closeThen(() => setChoosing(null))} />
  )
  return (
    <Stage view={view} image={now?.image ?? null} infoId={now?.id ?? null} keys={keys} dialogs={dialog}>
      {now && <Picture key={now.id} id={now.id} name={now.image?.filename ?? ''} />}
    </Stage>
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
