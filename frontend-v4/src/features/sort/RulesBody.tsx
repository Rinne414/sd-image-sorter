import { useEffect, useMemo, useState } from 'react'
import { useImageCount } from '../../api/queries'
import { useT } from '../../i18n'
import { tailOfPath } from '../../lib/paths'
import { apiSort } from '../../lib/sort'
import { useApp } from '../../state/store'
import { matchingIds } from '../selection/invert'
import { rememberDestination } from '../selection/dialogs'
import { AddRuleButton, MoreRules } from './MoreRules'
import moreStyles from './MoreRules.module.css'
import { conditionParams, isEverything, type RuleSetup } from './rules'
import { ConditionField, DestinationPicker, RulePreview, splitName } from './RulesParts'
import { startRulesRun } from './rulesActions'
import { PlanConfirm, useRulesPlan } from './RulesPlan'
import { allRules, rulesReady } from './ruleSet'
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

/** The Start button and the line beside it, for one rule or several. */
function startLine(t: Translate, setup: SortSetup, count: number | null, busy: boolean) {
  if (setup.more.length > 0) {
    const ready = rulesReady(setup)
    return {
      ready: ready && !busy,
      label: t('sort.rules.startRules', { n: allRules(setup).length }),
      status: busy ? t('sort.rules.planning') : ready ? t('sort.rules.ready') : t('sort.rules.needAllDest'),
    }
  }
  const label = count === null ? t('sort.rules.startPlain') : t(setup.operation === 'copy' ? 'sort.rules.startCopy' : 'sort.rules.startMove', { n: count })
  return { ready: !!setup.rule.destination && count !== 0 && !busy, label, status: setup.rule.destination ? t('sort.rules.ready') : t('sort.rules.needDest') }
}

/**
 * Sort by condition's setup: which images, where they go (one rule, or
 * several tried in order), move or copy, then start (asked first).
 */
export function RulesBody({ setup, update, picks, sourceFolder }: Props) {
  const t = useT()
  const sort = useApp((s) => s.sort)
  const sortReverse = useApp((s) => s.sortReverse)
  const [usePicks, setUsePicks] = useState(picks.length > 0)
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const rule = setup.rule
  const several = setup.more.length > 0
  const fromPicks = usePicks && picks.length > 0
  const planner = useRulesPlan(setup, fromPicks ? picks : null)
  const params = useMemo(() => conditionParams(rule.query, apiSort(sort, sortReverse)), [rule.query, sort, sortReverse])
  const matchCount = useImageCount(fromPicks ? null : params).data ?? null
  const count = fromPicks ? picks.length : matchCount
  const change = (next: SortSetup) => {
    setNotice(null)
    planner.clearNotice()
    update(next)
  }
  const setRule = (next: RuleSetup) => change({ ...setup, rule: next })

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

  const line = startLine(t, setup, count, several ? planner.planning : starting)
  const problem = several ? planner.notice : notice
  const plan = several ? planner.plan : null
  const firstNote = fromPicks ? t(rule.query.trim() ? 'sort.rules.inPicks' : 'sort.rules.inPicksRest') : undefined
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
            {(!fromPicks || several) && <ConditionField query={rule.query} count={matchCount} note={firstNote} onQuery={(query) => setRule({ ...rule, query })} />}
            {fromPicks && several && <p className={styles.note}>{t('sort.rules.firstInPicks')}</p>}
          </fieldset>
          <OperationPicker setup={setup} onChange={(operation) => change({ ...setup, operation })} />
        </div>
        <div className={styles.column}>
          <DestinationPicker rule={rule} sourceFolder={sourceFolder} onRule={setRule} legend={several ? t('sort.rules.destFirst') : undefined} />
          <RulePreview params={fromPicks ? null : params} picks={fromPicks ? picks : null} query={rule.query} />
        </div>
      </div>
      <MoreRules setup={setup} update={change} inPicks={fromPicks} sourceFolder={sourceFolder} />
      <div className={several ? `${styles.startRow} ${moreStyles.stickyStart}` : styles.startRow}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => (several ? void planner.make() : setConfirming(true))}
          disabled={!line.ready}
          data-testid="sort-start"
        >
          {line.label}
        </button>
        <p className={problem ? styles.error : styles.note} role={problem ? 'alert' : undefined} data-testid="sort-start-note">
          {problem ?? line.status}
        </p>
        <AddRuleButton setup={setup} update={change} />
      </div>
      {!several && confirming && count !== null && (
        <SortConfirm
          title={t('sort.rules.confirmTitle')}
          body={`${confirmBody(t, setup, count)}${!fromPicks && isEverything(rule.query) ? ` ${t('sort.rules.everything')}` : ''}`}
          confirmLabel={t(setup.operation === 'copy' ? 'sort.rules.confirmOkCopy' : 'sort.rules.confirmOkMove', { n: count })}
          onConfirm={start}
          onClose={() => setConfirming(false)}
        />
      )}
      {plan && <PlanConfirm plan={plan} copy={setup.operation === 'copy'} onConfirm={() => planner.run(plan)} onClose={planner.close} />}
    </>
  )
}
