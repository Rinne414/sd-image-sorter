import { useT, type MessageKey } from '../../i18n'
import { folderName, parentFolder, tailOfPath } from '../../lib/paths'
import { Icon } from '../../ui/Icon'
import { SLOT_KEYS, usableSlots, type SessionView, type SlotKey } from './sortSession'
import type { SortSetup } from './savedSetup'
import styles from './SortPage.module.css'

// The pieces of the Sort tab's setup: how to sort, what to sort, where each
// key sends an image, move or copy, and the unfinished sort to go back to.

/** Mono characters of the parent path shown next to a folder's name. */
const PARENT_CHARS = 40

/** A destination folder: its own name first, then the end of where it is (the whole path on hover). */
export function FolderLabel({ path }: { path: string }) {
  const parent = parentFolder(path)
  return (
    <span className={styles.folder} title={path}>
      <span className={styles.folderName}>{folderName(path)}</span>
      {parent && <span className={`${styles.folderParent} mono`}>{tailOfPath(parent, PARENT_CHARS)}</span>}
    </span>
  )
}

const LATER_MODES: MessageKey[] = ['sort.mode.bracket', 'sort.mode.cull', 'sort.mode.rules']

/** Only "keys to folders" works yet; the others say so instead of pretending. */
export function ModeSwitch() {
  const t = useT()
  return (
    <div className={styles.modes}>
      <div className={styles.modeRow} role="radiogroup" aria-label={t('sort.mode.label')}>
        <button type="button" role="radio" aria-checked="true" className={styles.mode} data-testid="sort-mode-slots">
          {t('sort.mode.slots')} <span className="mono">WASD</span>
        </button>
        {LATER_MODES.map((key) => (
          <button key={key} type="button" role="radio" aria-checked="false" className={styles.mode} disabled title={t('sort.mode.later')}>
            {t(key)}
          </button>
        ))}
      </div>
      <p className={styles.note}>{t('sort.mode.later')}</p>
    </div>
  )
}

export type SourceChoice = 'picks' | 'filter'

interface SourceProps {
  picks: number
  filterCount: number | null
  filterText: string
  choice: SourceChoice
  onChoice: (choice: SourceChoice) => void
}

export function SourcePicker({ picks, filterCount, filterText, choice, onChoice }: SourceProps) {
  const t = useT()
  return (
    <fieldset className={styles.group} data-testid="sort-source">
      <legend className={styles.section}>{t('sort.source.title')}</legend>
      {picks > 0 && (
        <label className={styles.option}>
          <input type="radio" name="sort-source" checked={choice === 'picks'} onChange={() => onChoice('picks')} />
          <span className={styles.optionText}>
            <span className={styles.optionTitle}>{t('sort.source.picks', { n: picks })}</span>
            <span className={styles.optionHint}>{t('sort.source.picksHint')}</span>
          </span>
        </label>
      )}
      <label className={styles.option}>
        <input type="radio" name="sort-source" checked={choice === 'filter'} onChange={() => onChoice('filter')} />
        <span className={styles.optionText}>
          <span className={styles.optionTitle}>
            {filterCount === null ? t('sort.source.filter') : t('sort.source.filterCount', { n: filterCount })}
          </span>
          <span className={styles.optionHint} title={filterText}>
            {t('sort.source.filterHint', { query: filterText })}
          </span>
        </span>
      </label>
    </fieldset>
  )
}

interface SlotsProps {
  setup: SortSetup
  onChoose: (slot: SlotKey) => void
  onClear: (slot: SlotKey) => void
}

export function SlotRows({ setup, onChoose, onClear }: SlotsProps) {
  const t = useT()
  return (
    <fieldset className={styles.group} data-testid="sort-slots">
      <legend className={styles.section}>{t('sort.slots.title')}</legend>
      <ul className={styles.slotList}>
        {SLOT_KEYS.map((slot) => {
          const path = setup.folders[slot] ?? null
          const key = slot.toUpperCase()
          return (
            <li key={slot} className={styles.slotRow} data-slot={slot}>
              <kbd className={styles.cap}>{key}</kbd>
              {path ? <FolderLabel path={path} /> : <span className={styles.unset}>{t('sort.slot.unset')}</span>}
              <button type="button" className="btn" onClick={() => onChoose(slot)} data-testid={`sort-choose-${slot}`}>
                {t(path ? 'sort.slot.change' : 'sort.slot.choose')}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => onClear(slot)}
                disabled={!path}
                aria-label={t('sort.slot.clear', { key })}
                title={t('sort.slot.clear', { key })}
              >
                <Icon name="close" size={13} />
              </button>
            </li>
          )
        })}
      </ul>
      <p className={styles.note}>{t('sort.slots.hint')}</p>
    </fieldset>
  )
}

interface OperationProps {
  setup: SortSetup
  onChange: (operation: SortSetup['operation']) => void
}

export function OperationPicker({ setup, onChange }: OperationProps) {
  const t = useT()
  const option = (op: SortSetup['operation'], title: MessageKey, hint: MessageKey) => (
    <label className={styles.option}>
      <input type="radio" name="sort-operation" checked={setup.operation === op} onChange={() => onChange(op)} data-testid={`sort-op-${op}`} />
      <span className={styles.optionText}>
        <span className={styles.optionTitle}>{t(title)}</span>
        <span className={styles.optionHint}>{t(hint)}</span>
      </span>
    </label>
  )
  return (
    <fieldset className={styles.group}>
      <legend className={styles.section}>{t('sort.op.title')}</legend>
      {option('move', 'sort.op.move', 'sort.op.moveHint')}
      {option('copy', 'sort.op.copy', 'sort.op.copyHint')}
    </fieldset>
  )
}

const MODE_NAME: Record<SessionView['mode'], MessageKey> = { slot: 'sort.mode.slots', bracket: 'sort.mode.bracket', cull: 'sort.mode.cull' }

/** The unfinished sort: continue it here, or in V3.5 when V4 cannot run its mode yet. */
export function ResumeCard({ view, onContinue }: { view: SessionView; onContinue: () => void }) {
  const t = useT()
  const at = Math.min(view.index + 1, view.total)
  if (view.mode !== 'slot') {
    return (
      <div className={styles.resume} data-testid="sort-resume">
        <p className={styles.resumeText}>{t('sort.resume.otherMode', { mode: t(MODE_NAME[view.mode]), at, total: view.total })}</p>
        <a className="btn" href="/">
          {t('sort.resume.openV3')}
        </a>
      </div>
    )
  }
  const op = t(view.operation === 'copy' ? 'sort.copying' : 'sort.moving')
  return (
    <div className={styles.resume} data-testid="sort-resume">
      <div className={styles.resumeText}>
        <strong>{t('sort.resume.title')}</strong>
        <span className={styles.optionHint}>
          {t('sort.resume.body', { at, total: view.total, op, n: usableSlots(view).length })}
        </span>
      </div>
      <button type="button" className="btn btn-primary" onClick={onContinue} data-testid="sort-continue">
        {t('sort.resume.continue')}
      </button>
    </div>
  )
}
