import { useState } from 'react'
import { useT } from '../../i18n'
import { tailOfPath } from '../../lib/paths'
import { apiSort } from '../../lib/sort'
import { useApp } from '../../state/store'
import { rememberDestination } from '../selection/dialogs'
import { matchingIds } from '../selection/invert'
import { conditionParams } from './rules'
import { startRulesGroups } from './rulesActions'
import { splitName } from './RulesParts'
import { allRules, assignRules, type RuleGroup } from './ruleSet'
import type { SortSetup } from './savedSetup'
import { SortConfirm } from './SortConfirm'
import styles from './MoreRules.module.css'

// Sort by condition with several rules: before anything moves, the page works
// out which images each rule takes (first match wins, V3.5's auto-sort) and
// asks, listing every rule's count and folder; then one run sorts them all.

export interface RulesPlan {
  groups: RuleGroup[]
  /** Picked images no rule took (they stay where they are). */
  left: number
}

/** Work out the plan for this setup (the picks are the pool when given); 'empty' when no rule takes any image. */
export async function planRules(setup: SortSetup, picks: number[] | null, sortBy: string): Promise<RulesPlan | 'empty'> {
  const rules = allRules(setup)
  const matched = await Promise.all(
    rules.map((rule) => (picks && !rule.query.trim() ? Promise.resolve(picks) : matchingIds(conditionParams(rule.query, sortBy)))),
  )
  const { groups, left } = assignRules(matched, picks)
  if (groups.every((ids) => ids.length === 0)) return 'empty'
  return { groups: groups.map((ids, i) => ({ ids, rule: rules[i]! })), left }
}

/** Planning, then asking: the Start button's work when there are several rules. */
export function useRulesPlan(setup: SortSetup, picks: number[] | null) {
  const t = useT()
  const sort = useApp((s) => s.sort)
  const sortReverse = useApp((s) => s.sortReverse)
  const [plan, setPlan] = useState<RulesPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const make = async () => {
    setPlanning(true)
    setNotice(null)
    try {
      const made = await planRules(setup, picks, apiSort(sort, sortReverse))
      if (made === 'empty') setNotice(t('sort.start.empty'))
      else setPlan(made)
    } catch (error) {
      setNotice(t('sort.start.failed', { reason: (error as Error).message }))
    }
    setPlanning(false)
  }

  const run = async (current: RulesPlan) => {
    const problem = await startRulesGroups(current.groups, setup)
    if (problem) setNotice(problem)
    else current.groups.forEach((g) => g.ids.length && g.rule.destination && rememberDestination(g.rule.destination))
  }

  return { plan, planning, notice, make, run, close: () => setPlan(null), clearNotice: () => setNotice(null) }
}

interface ConfirmProps {
  plan: RulesPlan
  copy: boolean
  onConfirm: () => Promise<unknown>
  onClose: () => void
}

/** Every rule's count and folder, before one run sorts them all. */
export function PlanConfirm({ plan, copy, onConfirm, onClose }: ConfirmProps) {
  const t = useT()
  const total = plan.groups.reduce((n, g) => n + g.ids.length, 0)
  return (
    <SortConfirm
      title={t('sort.rules.confirmTitleN', { n: plan.groups.length })}
      body={t(copy ? 'sort.rules.planCopy' : 'sort.rules.planMove')}
      confirmLabel={t(copy ? 'sort.rules.confirmOkCopy' : 'sort.rules.confirmOkMove', { n: total })}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <ol className={styles.plan} data-testid="sort-rules-plan">
        {plan.groups.map((g, i) => (
          <li key={i} data-count={g.ids.length} data-testid="sort-rules-plan-row">
            {t('sort.rules.planRow', {
              rule: i + 1,
              n: g.ids.length,
              folder: tailOfPath(g.rule.destination ?? '', 60),
              split: g.rule.splitBy === 'none' ? '' : t('sort.rules.confirmSplit', { how: splitName(t, g.rule.splitBy) }),
            })}
          </li>
        ))}
      </ol>
      {plan.left > 0 && (
        <p className={styles.hint} data-testid="sort-rules-plan-left">
          {t('sort.rules.planLeft', { n: plan.left })}
        </p>
      )}
    </SortConfirm>
  )
}
