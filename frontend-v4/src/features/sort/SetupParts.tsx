import { useT, type MessageKey } from '../../i18n'
import { folderName, parentFolder, tailOfPath } from '../../lib/paths'
import { Icon } from '../../ui/Icon'
import { round } from './sortModes'
import { COOLDOWN_MAX_MS, COOLDOWN_MIN_MS, COOLDOWN_STEP_MS, useSortPrefs } from './sortPrefs'
import { decided, SLOT_KEYS, summary, usableSlots, type SessionView, type SlotKey } from './sortSession'
import { useOtherLibrary } from './StageParts'
import { SETUP_MODES, type SetupMode, type SortSetup } from './savedSetup'
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

export const MODE_NAME: Record<SetupMode, MessageKey> = { slot: 'sort.mode.slots', bracket: 'sort.mode.bracket', cull: 'sort.mode.cull', rules: 'sort.mode.rules' }
const MODE_TEST: Record<SetupMode, string> = { slot: 'sort-mode-slots', bracket: 'sort-mode-bracket', cull: 'sort-mode-cull', rules: 'sort-mode-rules' }

/** The four ways to sort: three one image (or pair) at a time, and by condition all at once. */
export function ModeSwitch({ mode, onMode }: { mode: SetupMode; onMode: (mode: SetupMode) => void }) {
  const t = useT()
  return (
    <div className={styles.modes}>
      <div className={styles.modeRow} role="radiogroup" aria-label={t('sort.mode.label')}>
        {SETUP_MODES.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={styles.mode} onClick={() => onMode(m)} data-testid={MODE_TEST[m]}>
            {t(MODE_NAME[m])}
            {m === 'slot' && <span className="mono"> WASD</span>}
          </button>
        ))}
      </div>
      {mode === 'rules' && <p className={styles.note}>{t('sort.mode.rulesHint')}</p>}
    </div>
  )
}

/** A/B and keep/reject have no folders to set: how their keys work, instead. */
export function HowTo({ mode }: { mode: 'bracket' | 'cull' }) {
  const t = useT()
  return (
    <section className={styles.how} data-testid="sort-how">
      <h2 className={styles.section}>{t(mode === 'bracket' ? 'sort.how.bracket.title' : 'sort.how.cull.title')}</h2>
      <p className={styles.howBody}>{t(mode === 'bracket' ? 'sort.how.bracket.body' : 'sort.how.cull.body')}</p>
      <p className={styles.note}>{t('sort.how.keys')}</p>
    </section>
  )
}

/** Key cooldown, the sound and focus mode: kept for every sort, on this computer. */
export function OptionsPanel() {
  const t = useT()
  const prefs = useSortPrefs()
  const on = prefs.cooldownMs > 0
  return (
    <div className={styles.optionsRow} role="group" aria-label={t('sort.opt.title')} data-testid="sort-options">
      <span className={styles.presetsLabel}>{t('sort.opt.title')}</span>
      <label className={styles.inlineOption} title={t('sort.opt.cooldownHint')}>
        <input type="checkbox" checked={on} onChange={() => prefs.setCooldown(on ? 0 : DEFAULT_COOLDOWN_MS)} data-testid="sort-cooldown" />
        {t('sort.opt.cooldown')}
      </label>
      {on && (
        <span className={styles.range}>
          <input
            type="range"
            min={COOLDOWN_MIN_MS}
            max={COOLDOWN_MAX_MS}
            step={COOLDOWN_STEP_MS}
            value={prefs.cooldownMs}
            onChange={(e) => prefs.setCooldown(Number(e.target.value))}
            aria-label={t('sort.opt.cooldown')}
            data-testid="sort-cooldown-ms"
          />
          <span className="mono">{t('sort.opt.cooldownMs', { ms: prefs.cooldownMs })}</span>
        </span>
      )}
      <label className={styles.inlineOption}>
        <input type="checkbox" checked={prefs.sound} onChange={() => prefs.setSound(!prefs.sound)} data-testid="sort-sound-option" />
        {t('sort.opt.sound')}
      </label>
      <label className={styles.inlineOption} title={t('sort.focusHint')}>
        <input type="checkbox" checked={prefs.focus} onChange={() => prefs.setFocus(!prefs.focus)} data-testid="sort-focus-option" />
        {t('sort.opt.focus')}
      </label>
    </div>
  )
}

/** The cooldown a first tick of the box turns on. */
const DEFAULT_COOLDOWN_MS = 300

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
  onFavorites: (slot: SlotKey) => void
}

/** A key that adds to Favorites: that it does, and that the file stays where it is. */
function FavoritesLabel() {
  const t = useT()
  const label = t('rail.favorites')
  const note = t('sort.slot.addsNote')
  return (
    <span className={styles.folder} title={`${label} · ${note}`} data-testid="sort-slot-favorites">
      <span className={styles.folderName}>{label}</span>
      <span className={styles.folderParent}>{note}</span>
    </span>
  )
}

export function SlotRows({ setup, onChoose, onClear, onFavorites }: SlotsProps) {
  const t = useT()
  return (
    <fieldset className={styles.group} data-testid="sort-slots">
      <legend className={styles.section}>{t('sort.slots.title')}</legend>
      <div className={styles.keyboard}>
        {SLOT_KEYS.map((slot) => {
          const path = setup.folders[slot] ?? null
          const favorites = setup.favorites.includes(slot)
          const key = slot.toUpperCase()
          const set = path !== null || favorites
          return (
            <div key={slot} className={styles.keycap} data-slot={slot} data-set={set || undefined}>
              <span className={styles.keyLetter}>{key}</span>
              <span className={styles.keyTarget}>
                {path ? <FolderLabel path={path} /> : favorites ? <FavoritesLabel /> : <span className={styles.unset}>{t('sort.slot.unset')}</span>}
              </span>
              <span className={styles.keyActions}>
                <button type="button" className="btn btn-sm" onClick={() => onChoose(slot)} data-testid={`sort-choose-${slot}`}>
                  {t(path ? 'sort.slot.change' : 'sort.slot.choose')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => onFavorites(slot)}
                  disabled={favorites}
                  title={t('sort.slot.toFavoritesTip', { key })}
                  data-testid={`sort-favorites-${slot}`}
                >
                  {t('sort.slot.toFavorites')}
                </button>
              </span>
              <button
                type="button"
                className={`btn btn-sm btn-ghost btn-icon ${styles.keyClear}`}
                onClick={() => onClear(slot)}
                disabled={!set}
                aria-label={t('sort.slot.clear', { key })}
                title={t('sort.slot.clear', { key })}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )
        })}
      </div>
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

type Translate = ReturnType<typeof useT>

/** A sort in one line, for Home and the setup: where it is, and what it does. */
export function describeSession(t: Translate, view: SessionView): { title: string; line: string } {
  const at = Math.min(view.index + 1, view.total)
  if (view.mode === 'bracket') return { title: t('sort.home.nameBracket', round(view.index, view.total)), line: t('sort.home.metaBracket') }
  if (view.mode === 'cull') {
    const { keep, reject } = decided(view)
    return { title: t('sort.home.nameCull', { at, total: view.total }), line: t('sort.home.metaCull', { kept: keep.length, rejected: reject.length }) }
  }
  const op = t(view.operation === 'copy' ? 'sort.copying' : 'sort.moving')
  return { title: t('sort.home.name', { at, total: view.total }), line: t('sort.home.meta', { op, n: usableSlots(view).length, sent: summary(view).sent }) }
}

/** The unfinished sort, any way: continue it. Says so when its images belong to another library. */
export function ResumeCard({ view, onContinue }: { view: SessionView; onContinue: () => void }) {
  const t = useT()
  const { title, line } = describeSession(t, view)
  const other = useOtherLibrary(view)
  return (
    <div className={styles.resume} data-testid="sort-resume">
      <div className={styles.resumeText}>
        <strong>{t('sort.resume.title')}</strong>
        <span className={styles.optionHint}>
          {title} · {line}
        </span>
        {other && <span className={styles.warnLine}>{other.sentence}</span>}
      </div>
      <button type="button" className="btn btn-primary" onClick={onContinue} data-testid="sort-continue">
        {t('sort.resume.continue')}
      </button>
    </div>
  )
}
