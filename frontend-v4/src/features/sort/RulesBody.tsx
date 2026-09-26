import { useEffect, useMemo, useState } from 'react'
import { useImageCount } from '../../api/queries'
import { useT } from '../../i18n'
import { tailOfPath } from '../../lib/paths'
import { apiSort } from '../../lib/sort'
import { useApp } from '../../state/store'
import { matchingIds } from '../selection/invert'
import { rememberDestination } from '../selection/dialogs'
import { conditionParams, isEverything, type RuleSetup } from './rules'
import { ConditionField, DestinationPicker, RulePreview, splitName } from './RulesParts'
import { startRulesRun } from './rulesActions'
import type { SortSetup } from './savedSetup'
import { OperationPicker } from './SetupParts'
import { SortConfirm } from './SortConfirm'
import styles from './SortPage.module.css'

type Translate = ReturnType<typeof useT>

interface Props {
  setup: SortSetup
  update: (next: SortSetup) => void
  /** Picks handed over (or the library's); empty when there are none. */
  picks: number[]
  sourceFolder: string | null
}

function confirmBody(t: Translate, setup: SortSetup, n: number): string {
  const { rule, operation } = setup
  const split = rule.splitBy === 'none' ? '' : t('sort.rules.confirmSplit', { how: splitName(t, rule.splitBy) })
  const folder = tailOfPath(rule.destination ?? '', 60)
  return t(operation === 'copy' ? 'sort.rules.confirmCopy' : 'sort.rules.confirmMove', { n, folder, split })
}

/** Sort by condition's setup: which images, where they go, move or copy, then start (asked first). */
export function RulesBody({ setup, update, picks, sourceFolder }: Props) {
  const t = useT()
  const sort = useApp((s) => s.sort)
  const sortReverse = useApp((s) => s.sortReverse)
  const [usePicks, setUsePicks] = useState(picks.length > 0)
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const rule = setup.rule
  const fromPicks = usePicks && picks.length > 0
  const params = useMemo(() => conditionParams(rule.query, apiSort(sort, sortReverse)), [rule.query, sort, sortReverse])
  const matchCount = useImageCount(fromPicks ? null : params).data ?? null
  const count = fromPicks ? picks.length : matchCount
  const setRule = (next: RuleSetup) => {
    setNotice(null)
    update({ ...setup, rule: next })
  }

  // With no condition of its own yet, it starts from the library's search.
  useEffect(() => {
    const libraryQuery = useApp.getState().queryText.trim()
    if (!rule.query && libraryQuery) update({ ...setup, rule: { ...rule, query: libraryQuery } })
    // Once, when the page opens in this mode.
  }, [])

  const start = async () => {
    setStarting(true)
    let problem: string | null
    try {
      const ids = fromPicks ? picks : await matchingIds(params)
      problem = ids.length ? await startRulesRun(ids, setup) : t('sort.start.empty')
    } catch (error) {
      problem = t('sort.start.failed', { reason: (error as Error).message })
    }
    setStarting(false)
    if (problem) setNotice(problem)
    else if (rule.destination) rememberDestination(rule.destination)
  }

  const ready = !!rule.destination && count !== 0 && !starting
  const label = count === null ? t('sort.rules.startPlain') : t(setup.operation === 'copy' ? 'sort.rules.startCopy' : 'sort.rules.startMove', { n: count })
  return (
    <>
      <div className={styles.columns}>
        <div className={styles.column}>
          <fieldset className={styles.group} data-testid="sort-source">
            <legend className={styles.section}>{t('sort.source.title')}</legend>
            {picks.length > 0 && (
              <label className={styles.option}>
                <input type="radio" name="sort-rule-source" checked={fromPicks} onChange={() => setUsePicks(true)} />
                <span className={styles.optionTitle}>{t('sort.source.picks', { n: picks.length })}</span>
              </label>
            )}
            <label className={styles.option}>
              <input type="radio" name="sort-rule-source" checked={!fromPicks} onChange={() => setUsePicks(false)} data-testid="sort-rule-by-condition" />
              <span className={styles.optionTitle}>{t('sort.rules.condition')}</span>
            </label>
            {!fromPicks && <ConditionField query={rule.query} count={matchCount} onQuery={(query) => setRule({ ...rule, query })} />}
          </fieldset>
          <OperationPicker setup={setup} onChange={(operation) => update({ ...setup, operation })} />
        </div>
        <div className={styles.column}>
          <DestinationPicker rule={rule} sourceFolder={sourceFolder} onRule={setRule} />
          <RulePreview params={fromPicks ? null : params} picks={fromPicks ? picks : null} query={rule.query} />
        </div>
      </div>
      <div className={styles.startRow}>
        <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)} disabled={!ready} data-testid="sort-start">
          {label}
        </button>
        <p className={notice ? styles.error : styles.note} role={notice ? 'alert' : undefined}>
          {notice ?? (rule.destination ? t('sort.rules.ready') : t('sort.rules.needDest'))}
        </p>
      </div>
      {confirming && count !== null && (
        <SortConfirm
          title={t('sort.rules.confirmTitle')}
          body={`${confirmBody(t, setup, count)}${!fromPicks && isEverything(rule.query) ? ` ${t('sort.rules.everything')}` : ''}`}
          confirmLabel={t(setup.operation === 'copy' ? 'sort.rules.confirmOkCopy' : 'sort.rules.confirmOkMove', { n: count })}
          onConfirm={start}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  )
}
