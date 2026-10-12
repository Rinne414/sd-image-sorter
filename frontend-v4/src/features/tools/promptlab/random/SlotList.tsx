import { usePL } from '../plText'
import type { Violation } from '../types'
import { useCategoryLabel, useRuleName, isKnownCategory } from './labels'
import styles from './Random.module.css'
import { clearSlots, setRandom, setWeight, toggleLock, useRandom, weightOf } from './randomStore'
import { checkSlots, useRandomRun } from './runRandom'
import { conflictsBySlot, removeTag, type Conflict, type Rule } from './slots'

// The slots: per category its tags (× takes one out), a lock that keeps it
// through a randomize, a weight (the chance it is drawn) and, when a rule
// rules one of its tags out, which rule and why.

/** Always shown, filled or not, when the pool has them; any other category shows once it has tags. */
const CORE = ['character', 'outfit', 'pose', 'expression', 'body', 'background', 'style', 'quality']

function Slot({ cat, conflicts }: { cat: string; conflicts: Conflict[] | undefined }) {
  const p = usePL()
  const label = useCategoryLabel()
  const ruleName = useRuleName()
  const tags = useRandom((s) => s.slots[cat])
  const locked = useRandom((s) => !!s.locked[cat])
  const weight = useRandom((s) => weightOf(s, cat))
  const tone = isKnownCategory(cat) ? `cat-${cat}` : 'cat-unknown'
  return (
    <li className={styles.slot} data-slot={cat} data-locked={locked || undefined}>
      <button type="button" className={styles.lock} aria-pressed={locked} onClick={() => toggleLock(cat)} title={p('pl.rnd.lockTitle')} data-testid={`pl-lock-${cat}`}>
        {p(locked ? 'pl.rnd.locked' : 'pl.rnd.lock')}
      </button>
      <span className={styles.slotName}>{label(cat)}</span>
      <div className={styles.slotTags}>
        {tags?.length ? (
          tags.map((tag) => (
            <span key={tag} className={`chip ${tone}`} data-tag={tag}>
              {tag}
              <button type="button" className={styles.chipX} onClick={() => setRandom({ slots: removeTag(useRandom.getState().slots, cat, tag) })} aria-label={p('pl.rnd.remove', { tag })}>
                ×
              </button>
            </span>
          ))
        ) : (
          <span className={styles.muted}>{p('pl.rnd.slotEmpty')}</span>
        )}
      </div>
      <label className={styles.weight} title={p('pl.rnd.weightTitle', { cat: label(cat) })}>
        <input type="range" min={0} max={100} step={5} value={weight} onChange={(e) => setWeight(cat, Number(e.target.value))} aria-label={p('pl.rnd.weightTitle', { cat: label(cat) })} />
        <span className="mono">{weight}%</span>
      </label>
      {conflicts?.map((c) => (
        <p key={`${c.rule}:${c.tag}`} className={styles.warn} data-testid="pl-slot-conflict">
          {p('pl.rnd.conflict', { rule: ruleName(c.rule), when: c.when.join(', '), tag: c.tag })}
        </p>
      ))}
    </li>
  )
}

function CheckResult() {
  const p = usePL()
  const ruleName = useRuleName()
  const check = useRandomRun((s) => s.check)
  if (!check) return null
  if ('error' in check) return <p className={styles.problem}>{p('pl.rnd.checkFailed', { reason: check.error })}</p>
  if (!check.violations.length) return <p className={styles.ok} data-testid="pl-check-result">{p('pl.rnd.noConflicts')}</p>
  return <Violations list={check.violations} ruleName={ruleName} testId="pl-check-result" />
}

export function Violations({ list, ruleName, testId }: { list: Violation[]; ruleName: (name: string) => string; testId?: string }) {
  const p = usePL()
  return (
    <div className={styles.violations} data-testid={testId}>
      <span className={styles.muted}>{p('pl.rnd.conflicts', { n: list.length })}</span>
      {list.map((v, i) => (
        <p key={i} className={styles.warn}>
          {p('pl.rnd.conflict', { rule: ruleName(v.rule), when: v.triggering_tags.join(', '), tag: v.conflicting_tags.join(', ') })}
        </p>
      ))}
    </div>
  )
}

export function SlotList({ pool, rules }: { pool: Record<string, string[]>; rules: readonly Rule[] }) {
  const p = usePL()
  const slots = useRandom((s) => s.slots)
  const locked = useRandom((s) => s.locked)
  const shown = [...new Set([...CORE.filter((c) => c in pool), ...Object.keys(slots).filter((c) => slots[c]?.length || locked[c])])]
  const conflicts = conflictsBySlot(slots, rules)
  const hasTags = Object.values(slots).some((tags) => tags.length > 0)
  return (
    <section className={styles.panel} data-testid="pl-slots">
      <header className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{p('pl.rnd.slots')}</h3>
        <button type="button" className="btn" onClick={() => void checkSlots()} disabled={!hasTags} data-testid="pl-check">
          {p('pl.rnd.check')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={clearSlots} disabled={!hasTags} data-testid="pl-clear-slots">
          {p('pl.rnd.clear')}
        </button>
      </header>
      <p className={styles.muted}>{p('pl.rnd.slotsLead')}</p>
      <CheckResult />
      <ul className={styles.slots}>
        {shown.map((cat) => (
          <Slot key={cat} cat={cat} conflicts={conflicts[cat]} />
        ))}
      </ul>
    </section>
  )
}
