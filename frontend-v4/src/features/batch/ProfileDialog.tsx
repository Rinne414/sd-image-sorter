import { useRef, useState } from 'react'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { Icon } from '../../ui/Icon'
import { FilterPanel } from '../library/FilterPanel'
import { freeName, newProfile, newRule, removeProfile, replaceProfile, TONES, type Profile, type Rule, type Tone } from './queueSort'
import { useQueueProfiles } from './queueSortProfiles'
import styles from './QueueSort.module.css'

interface Props {
  /** The queue has fewer than two images: a profile can be saved but not applied. */
  few: boolean
  onClose: () => void
  onApply: (profile: Profile) => void
}

const same = (a: readonly Profile[], b: readonly Profile[]) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Saved sort profiles: a name and rules in order (a group name, a colour, and
 * a condition in the library's search language). An image goes to the first
 * rule it matches; what no rule takes is left in a group of its own. Edits
 * are kept in a draft until Save; Apply saves and sorts the queue.
 */
export function ProfileDialog({ few, onClose, onApply }: Props) {
  const t = useT()
  const saved = useQueueProfiles((s) => s.profiles)
  const [draft, setDraft] = useState<readonly Profile[]>(saved)
  const [selected, setSelected] = useState<string>(saved[0]?.id ?? '')
  const [warned, setWarned] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const dirty = !same(draft, saved)
  const profile = draft.find((p) => p.id === selected) ?? null

  const change = (next: readonly Profile[]) => {
    setDraft(next)
    setWarned(false)
  }
  const edit = (next: Profile) => change(replaceProfile(draft, next))
  const editRule = (id: string, patch: Partial<Rule>) => profile && edit({ ...profile, rules: profile.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) })

  const create = () => {
    const made = newProfile(freeName(t('partialsb.profile.defaultName'), draft.map((p) => p.name)), newRule(0, t('partialsb.profile.ruleName', { n: 1 })))
    change([...draft, made])
    setSelected(made.id)
    window.setTimeout(() => nameRef.current?.select(), 0)
  }

  const remove = () => {
    if (!profile) return
    const rest = removeProfile(draft, profile.id)
    change(rest)
    setSelected(rest[0]?.id ?? '')
  }

  const addRule = () => profile && edit({ ...profile, rules: [...profile.rules, newRule(profile.rules.length, t('partialsb.profile.ruleName', { n: profile.rules.length + 1 }))] })

  /** Names are kept as typed, with an empty or repeated name made unique, when saving. */
  const cleaned = (): readonly Profile[] => {
    const taken: string[] = []
    return draft.map((p) => {
      const name = freeName(p.name.trim() || t('partialsb.profile.defaultName'), taken)
      taken.push(name)
      return { ...p, name, rules: p.rules.map((r, i) => ({ ...r, name: r.name.trim() || t('partialsb.profile.ruleName', { n: i + 1 }) })) }
    })
  }

  const save = (): readonly Profile[] => {
    const list = cleaned()
    useQueueProfiles.getState().set(list)
    setDraft(list)
    setWarned(false)
    return list
  }

  const apply = () => {
    if (!profile) return
    const list = save()
    const now = list.find((p) => p.id === profile.id)
    if (!now) return
    onClose()
    onApply(now)
  }

  // Closing with edits not saved asks once: the same press again discards them.
  const close = () => {
    if (dirty && !warned) return setWarned(true)
    onClose()
  }

  return (
    <Dialog
      title={t('partialsb.profile.title')}
      onClose={close}
      wide
      testId="queue-profiles"
      footer={
        <>
          <span className={warned ? styles.warn : styles.note} role="status" data-testid="queue-profile-state">
            {warned ? t('partialsb.profile.unsavedWarn') : dirty ? t('partialsb.profile.unsaved') : ''}
          </span>
          <button type="button" className="btn btn-ghost" onClick={close} data-testid="queue-profile-close">
            {warned ? t('partialsb.profile.discard') : t('common.close')}
          </button>
          <button type="button" className="btn" disabled={!dirty} onClick={save} data-testid="queue-profile-save">
            {t('partialsb.profile.save')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!profile || profile.rules.length === 0 || few}
            title={few ? t('partialsb.sort.tooFew') : undefined}
            onClick={apply}
            data-testid="queue-profile-apply"
          >
            {t('partialsb.profile.apply')}
          </button>
        </>
      }
    >
      <p className={styles.help}>{t('partialsb.profile.help')}</p>
      <div className={styles.bar}>
        <select
          className={styles.select}
          value={profile?.id ?? ''}
          onChange={(e) => setSelected(e.target.value)}
          disabled={draft.length === 0}
          aria-label={t('partialsb.profile.pick')}
          data-testid="queue-profile-select"
        >
          {draft.length === 0 && <option value="">{t('partialsb.profile.none')}</option>}
          {draft.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={create} data-testid="queue-profile-new">
          {t('partialsb.profile.new')}
        </button>
        <button type="button" className="btn btn-ghost" disabled={!profile} onClick={remove} data-testid="queue-profile-delete">
          {t('partialsb.profile.delete')}
        </button>
      </div>
      {profile && (
        <>
          <label className={styles.nameRow}>
            <span>{t('partialsb.profile.name')}</span>
            <input
              ref={nameRef}
              value={profile.name}
              spellCheck={false}
              onChange={(e) => edit({ ...profile, name: e.target.value })}
              data-testid="queue-profile-name"
            />
          </label>
          <ol className={styles.rules} data-testid="queue-profile-rules">
            {profile.rules.map((rule, i) => (
              <li key={rule.id} className={styles.rule} data-testid="queue-profile-rule">
                <span className={styles.dot} data-tone={rule.tone} aria-hidden />
                <input
                  className={styles.ruleName}
                  value={rule.name}
                  spellCheck={false}
                  aria-label={t('partialsb.profile.ruleLabel', { n: i + 1 })}
                  onChange={(e) => editRule(rule.id, { name: e.target.value })}
                  data-testid="queue-rule-name"
                />
                <select
                  className={styles.tone}
                  value={rule.tone}
                  aria-label={t('partialsb.profile.tone')}
                  onChange={(e) => editRule(rule.id, { tone: e.target.value as Tone })}
                  data-testid="queue-rule-tone"
                >
                  {TONES.map((tone) => (
                    <option key={tone} value={tone}>
                      {t(`partialsb.tone.${tone}`)}
                    </option>
                  ))}
                </select>
                <input
                  className={styles.condition}
                  value={rule.condition}
                  spellCheck={false}
                  placeholder={t('partialsb.profile.conditionHint')}
                  aria-label={t('partialsb.profile.condition', { n: i + 1 })}
                  onChange={(e) => editRule(rule.id, { condition: e.target.value })}
                  data-testid="queue-rule-condition"
                />
                <FilterPanel text={rule.condition} onChange={(condition) => editRule(rule.id, { condition })} />
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  disabled={profile.rules.length < 2}
                  aria-label={t('partialsb.profile.removeRule', { n: i + 1 })}
                  title={t('partialsb.profile.removeRule', { n: i + 1 })}
                  onClick={() => edit({ ...profile, rules: profile.rules.filter((r) => r.id !== rule.id) })}
                  data-testid="queue-rule-remove"
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ol>
          <div className={styles.addRow}>
            <button type="button" className="btn" onClick={addRule} data-testid="queue-rule-add">
              {t('partialsb.profile.addRule')}
            </button>
            <span className={styles.note}>{t('partialsb.profile.rest')}</span>
          </div>
        </>
      )}
    </Dialog>
  )
}
