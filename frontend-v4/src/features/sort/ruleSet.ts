import { EMPTY_RULE, type RuleSetup } from './rules'
import type { SortSetup } from './savedSetup'
import type { FileOperation } from './sortSession'

// Sort by condition with several rules, as V3.5's auto-sort profiles did it:
// the setup's first rule, then the ones added under it. In that order, an
// image goes to the first rule it matches; an image no rule matches stays
// where it is. Every function returns new data.

export function allRules(setup: SortSetup): RuleSetup[] {
  return [setup.rule, ...setup.more]
}

export function addRule(setup: SortSetup): SortSetup {
  return { ...setup, more: [...setup.more, EMPTY_RULE] }
}

/** Change the rule at `index` in allRules (0 = the first rule). */
export function setRule(setup: SortSetup, index: number, rule: RuleSetup): SortSetup {
  if (index === 0) return { ...setup, rule }
  return { ...setup, more: setup.more.map((r, i) => (i === index - 1 ? rule : r)) }
}

/** Take out an added rule (the first one always stays). */
export function removeRule(setup: SortSetup, index: number): SortSetup {
  if (index < 1) return setup
  return { ...setup, more: setup.more.filter((_, i) => i !== index - 1) }
}

export function rulesReady(setup: SortSetup): boolean {
  return allRules(setup).every((r) => !!r.destination)
}

export interface RuleGroup {
  ids: number[]
  rule: RuleSetup
}

const splitOf = (rule: RuleSetup) => (rule.splitBy === 'none' ? null : rule.splitBy)

/**
 * Body of POST /api/batch-move for several rules: one run (one undo) where
 * each group of images goes to its rule's folder and split. The top-level
 * folder and split are the first group's, for the run's own record.
 */
export function groupsBody(groups: readonly RuleGroup[], operation: FileOperation) {
  const used = groups.filter((g) => g.ids.length > 0)
  return {
    image_ids: used.flatMap((g) => g.ids),
    destination_folder: used[0]?.rule.destination ?? '',
    operation,
    split_by: null,
    groups: used.map((g) => ({ image_ids: g.ids, destination_folder: g.rule.destination ?? '', split_by: splitOf(g.rule) })),
    // Filter settings the request model requires; unused when image_ids is given.
    tag_mode: 'and',
    prompt_match_mode: 'exact',
  }
}

/**
 * The images each rule takes, from what each rule's condition matched: an
 * image goes to the first rule that matched it. With a pool (the picks) only
 * its images count, and `left` says how many of them no rule took.
 */
export function assignRules(matched: readonly (readonly number[])[], pool: readonly number[] | null): { groups: number[][]; left: number } {
  const inPool = pool ? new Set(pool) : null
  const taken = new Set<number>()
  const groups = matched.map((ids) => {
    const group: number[] = []
    for (const id of ids) {
      if (taken.has(id) || (inPool && !inPool.has(id))) continue
      taken.add(id)
      group.push(id)
    }
    return group
  })
  return { groups, left: pool ? pool.filter((id) => !taken.has(id)).length : 0 }
}
