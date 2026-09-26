import { useMemo, useState } from 'react'
import { findLoadedImage } from '../../api/loaded'
import { useImageCount } from '../../api/queries'
import { useT } from '../../i18n'
import { parentFolder } from '../../lib/paths'
import { useApp } from '../../state/store'
import { currentLibraryParams } from '../library/params'
import { matchingIds } from '../selection/invert'
import { rememberDestination } from '../selection/dialogs'
import { loadSetup, MIN_IMAGES, saveSetup, setupReady, withFolder, type SortSetup as Setup } from './savedSetup'
import { PresetBar } from './PresetBar'
import { RulesBody } from './RulesBody'
import { LastRunCard } from './RulesParts'
import { useRules, useRulesRecord } from './rulesActions'
import { HowTo, ModeSwitch, OperationPicker, OptionsPanel, ResumeCard, SlotRows, SourcePicker, type SourceChoice } from './SetupParts'
import { SlotFolderDialog } from './SlotFolderDialog'
import { SortConfirm } from './SortConfirm'
import styles from './SortPage.module.css'
import { leftToSort, unfinished, type SlotKey, type SortMode } from './sortSession'
import { useSort } from './sortStore'

/** What the setup says under the start button: a problem, or the keys to use once it starts. */
type Notice = { kind: 'error'; text: string } | { kind: 'busy'; text: string } | null

type Translate = ReturnType<typeof useT>

function startLabel(t: Translate, mode: SortMode, count: number | null): string {
  if (count === null) return t('sort.start.plain')
  if (mode === 'bracket') return t('sort.start.bracket', { n: count })
  return t(mode === 'cull' ? 'sort.start.cull' : 'sort.start', { n: count })
}

/** The line next to the start button when nothing went wrong. */
function readyHint(t: Translate, setup: Setup, count: number | null): string {
  if (!setupReady(setup)) return t('sort.start.needSlot')
  if (count !== null && count < MIN_IMAGES[setup.mode]) return t(setup.mode === 'bracket' ? 'sort.start.needTwo' : 'sort.start.empty')
  if (setup.mode === 'bracket') return t('sort.start.keysBracket')
  return t(setup.mode === 'cull' ? 'sort.start.keysCull' : 'sort.start.keys')
}

/** The images the setup offers: the picks handed over (or the library's), or what its filter matches. */
function useSources() {
  const t = useT()
  const libraryId = useApp((s) => s.libraryId)
  const selection = useApp((s) => s.selection)
  const queryText = useApp((s) => s.queryText)
  const scope = useApp((s) => s.scope)
  const source = useSort((s) => s.source)
  const picks = source?.kind === 'picks' ? source.ids : selection
  const params = useMemo(currentLibraryParams, [libraryId, queryText, scope])
  const filterCount = useImageCount(params).data ?? null
  const scoped = scope.generators.length > 0 || scope.folder !== null || scope.favorites
  const filterText = [queryText.trim(), scoped ? t('sort.source.scoped') : ''].filter(Boolean).join(' · ') || t('sort.source.wholeLibrary')
  const initial: SourceChoice = source?.kind === 'filter' || picks.length === 0 ? 'filter' : 'picks'
  return { picks, params, filterCount, filterText, initial }
}

/** A new sort: how, which images, and (keys to folders) which folder behind each key, move or copy. */
export function SortSetup() {
  const t = useT()
  const libraryId = useApp((s) => s.libraryId)
  const pending = unfinished(useSort((s) => s.session))
  const lastRun = useRulesRecord(libraryId)
  const { picks, params, filterCount, filterText, initial } = useSources()
  const [setup, setSetup] = useState<Setup>(() => loadSetup(libraryId))
  const [choice, setChoice] = useState<SourceChoice>(initial)
  const [choosing, setChoosing] = useState<SlotKey | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [starting, setStarting] = useState(false)
  const count = choice === 'picks' ? picks.length : filterCount
  const sourceFolder = useMemo(() => {
    const img = choice === 'picks' && picks[0] !== undefined ? findLoadedImage(picks[0]) : null
    return img ? parentFolder(img.path) : null
  }, [choice, picks])

  const update = (next: Setup) => {
    setSetup(next)
    saveSetup(libraryId, next)
    setNotice(null)
  }

  /** Start the session; what went wrong, or null once it runs. */
  const startWith = async (replace: boolean): Promise<string | 'conflict' | null> => {
    let ids: number[]
    try {
      ids = choice === 'picks' ? picks : await matchingIds(params)
    } catch (error) {
      return t('sort.start.failed', { reason: (error as Error).message })
    }
    if (ids.length < MIN_IMAGES[setup.mode]) return t(setup.mode === 'bracket' ? 'sort.start.needTwo' : 'sort.start.empty')
    const result = await useSort.getState().start(ids, setup, replace)
    if (result === 'conflict') return 'conflict'
    if (result !== 'ok') return t('sort.start.failed', { reason: result.error })
    if (setup.mode === 'slot') for (const path of Object.values(setup.folders)) if (path) rememberDestination(path)
    return null
  }

  const begin = async (replace: boolean) => {
    if (starting) return
    if (!setupReady(setup)) return setNotice({ kind: 'error', text: t('sort.start.needSlot') })
    if (pending && !replace) return setConfirming(true)
    // A key pressed while it starts (Space, Enter) must not press the start button again.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    setStarting(true)
    setNotice(choice === 'filter' ? { kind: 'busy', text: t('sort.start.resolving') } : null)
    const problem = await startWith(replace)
    setStarting(false)
    if (problem === 'conflict') setConfirming(true)
    else if (problem) setNotice({ kind: 'error', text: problem })
  }

  const enough = count === null || count >= MIN_IMAGES[setup.mode]
  const canStart = setupReady(setup) && enough && !starting

  return (
    <section className={styles.page} data-testid="sort-setup">
      <div className={styles.sheet}>
        <h1 className={styles.title}>{t('sort.title')}</h1>
        <p className={styles.lede}>{t('sort.lede')}</p>
        {pending && <ResumeCard view={pending} onContinue={() => useSort.getState().resume()} />}
        <PresetBar libraryId={libraryId} setup={setup} onLoad={update} />
        <ModeSwitch mode={setup.mode} onMode={(mode) => update({ ...setup, mode })} />
        {setup.mode === 'rules' && lastRun && !lastRun.open && <LastRunCard record={lastRun} onView={() => useRules.getState().set({ ...lastRun, open: true })} />}
        {setup.mode === 'rules' ? (
          <RulesBody setup={setup} update={update} picks={picks} sourceFolder={sourceFolder} />
        ) : (
          <>
        <div className={styles.columns}>
          <div className={styles.column}>
            <SourcePicker picks={picks.length} filterCount={filterCount} filterText={filterText} choice={choice} onChoice={setChoice} />
            {choice === 'filter' && filterCount === 0 && (
              <p className={styles.warn}>
                {t('sort.source.empty')}{' '}
                <button type="button" className={styles.link} onClick={() => useApp.getState().setPage('library')}>
                  {t('sort.source.toLibrary')}
                </button>
              </p>
            )}
            {setup.mode === 'slot' && <OperationPicker setup={setup} onChange={(operation) => update({ ...setup, operation })} />}
          </div>
          <div className={styles.column}>
            {setup.mode === 'slot' ? (
              <SlotRows setup={setup} onChoose={setChoosing} onClear={(slot) => update(withFolder(setup, slot, null))} />
            ) : (
              <HowTo mode={setup.mode} />
            )}
          </div>
        </div>
        <OptionsPanel />
        <div className={styles.startRow}>
          <button type="button" className="btn btn-primary" onClick={() => void begin(false)} disabled={!canStart} data-testid="sort-start">
            {startLabel(t, setup.mode, count)}
          </button>
          <p className={notice?.kind === 'error' ? styles.error : styles.note} role={notice?.kind === 'error' ? 'alert' : undefined}>
            {notice ? notice.text : readyHint(t, setup, count)}
          </p>
        </div>
          </>
        )}
      </div>
      {choosing && (
        <SlotFolderDialog
          slot={choosing}
          current={setup.folders[choosing] ?? null}
          sourceFolder={sourceFolder}
          onChoose={async (path) => {
            update(withFolder(setup, choosing, path))
            return true
          }}
          onClose={() => setChoosing(null)}
        />
      )}
      {confirming && pending && (
        <SortConfirm
          title={t('sort.replace.title')}
          body={t('sort.replace.body', { left: leftToSort(pending) })}
          confirmLabel={t('sort.replace.confirm')}
          onConfirm={() => begin(true)}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  )
}
