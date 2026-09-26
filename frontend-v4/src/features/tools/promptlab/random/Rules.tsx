import { useState } from 'react'
import { useT } from '../../../../i18n'
import { Dialog } from '../../../../ui/Dialog'
import { useToasts } from '../../../../ui/toasts'
import { tr } from '../../../jobs/jobs'
import { plt, usePL } from '../plText'
import { useRuleName } from './labels'
import styles from './Random.module.css'
import { createRule, deleteRule, isOwn, type NewRule } from './randomApi'
import type { Rule } from './slots'

// 排除规则: "with these tags, not those". Randomize avoids what a rule rules
// out and Check conflicts points it out. New rules can be made here (V3.5
// could only list and delete them).

const splitWords = (text: string) => [...new Set(text.split(/[,\n]/).map((w) => w.trim()).filter(Boolean))]

function NewRuleDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const p = usePL()
  const [name, setName] = useState('')
  const [when, setWhen] = useState('')
  const [not, setNot] = useState('')
  const [description, setDescription] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const submit = async () => {
    const rule: NewRule = { name: name.trim(), when: splitWords(when), not: splitWords(not), description: description.trim() }
    if (!rule.name || !rule.when.length || !rule.not.length) {
      setProblem(p('pl.rnd.needRuleFields'))
      return
    }
    try {
      await createRule(rule)
      useToasts.getState().push(plt('pl.rnd.ruleCreated', { name: rule.name }))
      onClose()
    } catch (error) {
      setProblem(p('pl.rnd.saveFailed', { reason: (error as Error).message }))
    }
  }
  const footer = (
    <>
      <button type="button" className="btn" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void submit()} data-testid="pl-rule-create">
        {p('pl.rnd.create')}
      </button>
    </>
  )
  return (
    <Dialog title={p('pl.rnd.ruleNewTitle')} onClose={onClose} footer={footer} testId="pl-rule-dialog">
      <div className={styles.form}>
        <label className={styles.field}>
          <span className={styles.subLabel}>{p('pl.rnd.name')}</span>
          <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} data-testid="pl-rule-name" />
        </label>
        <label className={styles.field}>
          <span className={styles.subLabel}>{p('pl.rnd.ruleWhen')}</span>
          <input className={styles.input} value={when} onChange={(e) => setWhen(e.target.value)} spellCheck={false} data-testid="pl-rule-when" />
        </label>
        <label className={styles.field}>
          <span className={styles.subLabel}>{p('pl.rnd.ruleNot')}</span>
          <input className={styles.input} value={not} onChange={(e) => setNot(e.target.value)} spellCheck={false} data-testid="pl-rule-not" />
        </label>
        <label className={styles.field}>
          <span className={styles.subLabel}>{p('pl.rnd.description')}</span>
          <input className={styles.input} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {problem && <p className={styles.problem}>{problem}</p>}
      </div>
    </Dialog>
  )
}

/** Delete one of the user's rules; Undo makes it again (with a new id). */
async function removeRule(rule: Rule): Promise<void> {
  try {
    await deleteRule(rule.id ?? rule.name)
  } catch (error) {
    useToasts.getState().push(plt('pl.rnd.deleteFailed', { reason: (error as Error).message }), 'error')
    return
  }
  const again: NewRule = {
    name: rule.name,
    description: rule.description ?? '',
    when: rule.conditions.map((c) => c.tag),
    not: rule.targets.map((t) => t.tag).filter(Boolean),
  }
  useToasts.getState().push(plt('pl.rnd.ruleDeleted', { name: rule.name }), 'info', { label: tr('toast.undo'), run: () => void createRule(again) })
}

function RuleRow({ rule }: { rule: Rule }) {
  const p = usePL()
  const ruleName = useRuleName()
  const when = rule.conditions.map((c) => c.tag).join(', ')
  const not = rule.targets.map((t) => t.tag).filter(Boolean).join(', ')
  return (
    <li className={styles.listRow} data-rule={rule.name}>
      <div className={styles.listHead}>
        <span className={styles.listName}>{ruleName(rule.name)}</span>
        {!isOwn(rule.id) && <span className={styles.badge}>{p('pl.rnd.builtin')}</span>}
        <span className={styles.listActions}>
          {isOwn(rule.id) && (
            <button type="button" className={styles.textButton} onClick={() => void removeRule(rule)} data-action="delete">
              {p('pl.rnd.delete')}
            </button>
          )}
        </span>
      </div>
      <span className={styles.muted}>
        {p('pl.rnd.ruleText', { when, not })}
      </span>
    </li>
  )
}

export function Rules({ rules }: { rules: Rule[] }) {
  const p = usePL()
  const [creating, setCreating] = useState(false)
  return (
    <section className={styles.panel} data-testid="pl-rules">
      <header className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{p('pl.rnd.rules')}</h3>
        <button type="button" className="btn" onClick={() => setCreating(true)} data-testid="pl-rule-new">
          {p('pl.rnd.ruleNew')}
        </button>
      </header>
      <p className={styles.muted}>{p('pl.rnd.rulesLead')}</p>
      <ul className={styles.list}>
        {rules.map((rule) => (
          <RuleRow key={String(rule.id ?? rule.name)} rule={rule} />
        ))}
      </ul>
      {creating && <NewRuleDialog onClose={() => setCreating(false)} />}
    </section>
  )
}
