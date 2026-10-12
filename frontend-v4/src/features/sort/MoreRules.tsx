import { useMemo, useState } from 'react'
import { useImageCount } from '../../api/queries'
import { useT } from '../../i18n'
import { apiSort } from '../../lib/sort'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import styles from './MoreRules.module.css'
import { conditionParams, SPLITS, type RuleSetup, type SplitBy } from './rules'
import { ConditionField, splitName } from './RulesParts'
import { addRule, removeRule, setRule } from './ruleSet'
import type { SortSetup } from './savedSetup'
import { FolderLabel } from './SetupParts'
import { SlotFolderDialog } from './SlotFolderDialog'

// Sort by condition's further rules (V3.5's auto-sort profiles): each a
// condition and a folder, tried in order after the first rule; an image goes
// to the first rule it matches, and an image no rule matches stays put.

interface Props {
  setup: SortSetup
  update: (next: SortSetup) => void
  /** The picks are the images to sort: each condition picks from them. */
  inPicks: boolean
  sourceFolder: string | null
}

/** The rules after the first, once there are any (the button that adds one sits by Start). */
export function MoreRules({ setup, update, inPicks, sourceFolder }: Props) {
  const t = useT()
  if (setup.more.length === 0) return null
  return (
    <section className={styles.more} data-testid="sort-more-rules">
      <h2 className={styles.title}>{t('sort.rules.more')}</h2>
      <p className={styles.hint}>{t('sort.rules.orderHint')}</p>
      <ol className={styles.list}>
        {setup.more.map((rule, i) => (
          <RuleRow
            key={i}
            place={i + 1}
            rule={rule}
            inPicks={inPicks}
            sourceFolder={sourceFolder}
            onRule={(next) => update(setRule(setup, i + 1, next))}
            onRemove={() => update(removeRule(setup, i + 1))}
          />
        ))}
      </ol>
    </section>
  )
}

/** Add a rule under the others. */
export function AddRuleButton({ setup, update }: Pick<Props, 'setup' | 'update'>) {
  const t = useT()
  return (
    <button type="button" className={`btn ${styles.add}`} onClick={() => update(addRule(setup))} title={t('sort.rules.moreHint')} data-testid="sort-rule-add">
      <Icon name="plus" size={12} />
      {t('sort.rules.add')}
    </button>
  )
}

interface RowProps {
  /** Its place in all the rules (0 is the first rule, above). */
  place: number
  rule: RuleSetup
  inPicks: boolean
  sourceFolder: string | null
  onRule: (rule: RuleSetup) => void
  onRemove: () => void
}

function RuleRow({ place, rule, inPicks, sourceFolder, onRule, onRemove }: RowProps) {
  const t = useT()
  const sort = useApp((s) => s.sort)
  const sortReverse = useApp((s) => s.sortReverse)
  const [choosing, setChoosing] = useState(false)
  const params = useMemo(() => conditionParams(rule.query, apiSort(sort, sortReverse)), [rule.query, sort, sortReverse])
  const count = useImageCount(inPicks ? null : params).data ?? null
  const n = place + 1
  return (
    <li className={styles.row} data-testid="sort-more-rule">
      <span className={`${styles.number} mono`}>{t('sort.rules.ruleN', { n })}</span>
      <div className={styles.body}>
        <ConditionField
          query={rule.query}
          count={count}
          note={inPicks ? t(rule.query.trim() ? 'sort.rules.inPicks' : 'sort.rules.inPicksRest') : undefined}
          onQuery={(query) => onRule({ ...rule, query })}
          testId="sort-more-condition"
        />
        <div className={styles.dest}>
          {rule.destination ? <FolderLabel path={rule.destination} /> : <span className={styles.unset}>{t('sort.rules.destNone')}</span>}
          <button type="button" className="btn" onClick={() => setChoosing(true)} data-testid="sort-more-choose">
            {t(rule.destination ? 'sort.rules.destChange' : 'sort.rules.destChoose')}
          </button>
          <label className={styles.split}>
            <span>{t('sort.rules.split')}</span>
            <select value={rule.splitBy} onChange={(e) => onRule({ ...rule, splitBy: e.target.value as SplitBy })} data-testid="sort-more-split">
              {SPLITS.map((s) => (
                <option key={s} value={s}>
                  {splitName(t, s)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        onClick={onRemove}
        aria-label={t('sort.rules.remove', { n })}
        title={t('sort.rules.remove', { n })}
        data-testid="sort-more-remove"
      >
        <Icon name="close" size={13} />
      </button>
      {choosing && (
        <SlotFolderDialog
          slot="w"
          title={t('sort.rules.destTitleN', { n })}
          current={rule.destination}
          sourceFolder={sourceFolder}
          onChoose={async (path) => {
            onRule({ ...rule, destination: path })
            return true
          }}
          onClose={() => setChoosing(false)}
        />
      )}
    </li>
  )
}
