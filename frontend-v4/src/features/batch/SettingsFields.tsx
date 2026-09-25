import { useState, type RefObject } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { defaultTemplate, templateIsOwn, withTargetModel, type TemplatePreset } from './captionRules'
import {
  CATEGORIES,
  categoriesChanged,
  joinList,
  PURPOSES,
  splitList,
  TARGET_MODELS,
  toggleCategory,
  withPurpose,
  type DatasetForm,
  type Purpose,
  type TargetModel,
  type TriggerProblem,
} from './datasetSettings'
import styles from './DatasetSettings.module.css'
import type { useDatasetSettings } from './useDatasetSettings'

const QUALITY_TAGS = ['masterpiece', 'best quality']

const TRIGGER_PROBLEM: Record<TriggerProblem, MessageKey> = {
  comma: 'dataset.set.triggerComma',
  breaks: 'dataset.set.triggerBreaks',
  long: 'dataset.set.triggerLong',
  blank: 'dataset.set.triggerBlank',
}

const MODEL_KEY = (m: TargetModel) => (m === '' ? 'none' : m)

interface Props {
  s: ReturnType<typeof useDatasetSettings>
  form: DatasetForm
  presets: readonly TemplatePreset[]
  variables: readonly string[]
  triggerRef: RefObject<HTMLInputElement | null>
}

/** The settings form: trigger, base model, purpose, common tags, blacklist, max tags, template. */
export function SettingsFields({ s, form, presets, variables, triggerRef }: Props) {
  const t = useT()
  const edit = s.edit
  const hasQuality = QUALITY_TAGS.every((q) => splitList(form.commonTags).some((tag) => tag.toLowerCase().replace(/_/g, ' ') === q))
  const oldOnList = s.savedTrigger !== '' && form.trigger !== s.savedTrigger && splitList(form.blacklist).includes(s.savedTrigger)

  return (
    <div className={styles.form} data-testid="dataset-settings-form">
      <label className={styles.field}>
        <span>{t('dataset.set.trigger')}</span>
        <input
          ref={triggerRef}
          value={s.triggerText}
          maxLength={120}
          spellCheck={false}
          aria-invalid={s.triggerIssue !== null}
          placeholder={t('dataset.set.triggerPlaceholder')}
          onChange={(e) => s.setTriggerText(e.target.value)}
          onBlur={s.commitTrigger}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              s.commitTrigger()
            }
          }}
          data-testid="dataset-trigger"
        />
        {s.triggerIssue ? <p className={styles.problem}>{t(TRIGGER_PROBLEM[s.triggerIssue])}</p> : <p className={styles.hint}>{t('dataset.set.triggerHint')}</p>}
        {oldOnList && (
          <p className={styles.note} data-testid="dataset-old-trigger">
            {t('dataset.set.oldTrigger', { old: s.savedTrigger })}
          </p>
        )}
      </label>

      <label className={styles.field}>
        <span>{t('dataset.set.model')}</span>
        <select value={form.targetModel} onChange={(e) => edit((f) => withTargetModel(f, e.target.value as TargetModel, presets))} data-testid="dataset-model">
          {TARGET_MODELS.map((m) => (
            <option key={m} value={m}>
              {t(`dataset.model.${MODEL_KEY(m)}` as MessageKey)}
            </option>
          ))}
        </select>
        <p className={styles.hint}>{t(`dataset.modelHint.${MODEL_KEY(form.targetModel)}` as MessageKey)}</p>
      </label>

      <div className={styles.field}>
        <span>{t('dataset.set.purpose')}</span>
        <select
          value={form.purpose ?? ''}
          aria-label={t('dataset.set.purpose')}
          onChange={(e) => edit((f) => withPurpose(f, (e.target.value || null) as Purpose | null))}
          data-testid="dataset-purpose"
        >
          <option value="">{t('dataset.purpose.none')}</option>
          {PURPOSES.map((p) => (
            <option key={p} value={p}>
              {t(`dataset.purpose.${p}` as MessageKey)}
            </option>
          ))}
        </select>
        <p className={styles.hint}>{t('dataset.set.categoriesHint')}</p>
        <div className={styles.cats} role="group" aria-label={t('dataset.set.categories')} data-testid="dataset-categories">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={`chip cat-${c} ${styles.cat}`}
              aria-pressed={form.removeCategories.includes(c)}
              onClick={() => edit((f) => toggleCategory(f, c))}
              data-cat={c}
            >
              {t(`dataset.cat.${c}` as MessageKey)}
            </button>
          ))}
        </div>
        {form.purpose && categoriesChanged(form) && (
          <div className={styles.row}>
            <span className={styles.note}>{t('dataset.set.categoriesChanged')}</span>
            <button type="button" className="btn btn-ghost" onClick={() => edit((f) => withPurpose(f, f.purpose))}>
              {t('dataset.set.categoriesReset')}
            </button>
          </div>
        )}
      </div>

      <label className={styles.field}>
        <span>{t('dataset.set.common')}</span>
        <textarea value={form.commonTags} rows={2} onChange={(e) => edit((f) => ({ ...f, commonTags: e.target.value }))} data-testid="dataset-common" />
        <span className={styles.row}>
          <span className={styles.hint}>{t('dataset.set.commonHint')}</span>
          {!hasQuality && (
            <button type="button" className="btn btn-ghost" onClick={() => edit((f) => ({ ...f, commonTags: joinList(splitList(`${f.commonTags}, ${QUALITY_TAGS.join(', ')}`)) }))}>
              {t('dataset.set.addQuality')}
            </button>
          )}
        </span>
      </label>

      <label className={styles.field}>
        <span>{t('dataset.set.blacklist')}</span>
        <textarea value={form.blacklist} rows={2} onChange={(e) => edit((f) => ({ ...f, blacklist: e.target.value }))} data-testid="dataset-blacklist" />
        <p className={styles.hint}>{t('dataset.set.blacklistHint')}</p>
      </label>

      <label className={styles.field}>
        <span>{t('dataset.set.maxTags')}</span>
        <input
          type="number"
          min={0}
          max={1000}
          value={form.maxTags}
          onChange={(e) => edit((f) => ({ ...f, maxTags: Number(e.target.value) || 0 }))}
          data-testid="dataset-max-tags"
        />
        <p className={styles.hint}>{t('dataset.set.maxTagsHint')}</p>
      </label>

      <Advanced s={s} form={form} presets={presets} variables={variables} />
    </div>
  )
}

function Advanced({ s, form, presets, variables }: Omit<Props, 'triggerRef'>) {
  const t = useT()
  const edit = s.edit
  const own = templateIsOwn(form, presets)
  // Open at first when the template is the user's own; after that it is theirs to open and close.
  const [open, setOpen] = useState(own)
  return (
    <details className={styles.advanced} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{t('dataset.set.advanced')}</summary>
      <label className={styles.field}>
        <span>{t('dataset.set.template')}</span>
        <textarea value={form.template} rows={2} spellCheck={false} onChange={(e) => edit((f) => ({ ...f, template: e.target.value }))} data-testid="dataset-template" />
        <span className={styles.row}>
          <span className={styles.hint}>{own ? t('dataset.set.templateOwn') : t('dataset.set.templateFromModel')}</span>
          {own && (
            <button type="button" className="btn btn-ghost" onClick={() => edit((f) => ({ ...f, template: defaultTemplate(f.targetModel, presets) }))}>
              {t('dataset.set.templateReset')}
            </button>
          )}
        </span>
        <ul className={styles.vars} aria-label={t('dataset.set.variables')}>
          {variables.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
      </label>
      <label className={styles.field}>
        <span>{t('dataset.set.replace')}</span>
        <textarea value={form.replaceRules} rows={2} spellCheck={false} placeholder="long_hair -> long hair" onChange={(e) => edit((f) => ({ ...f, replaceRules: e.target.value }))} />
        <p className={styles.hint}>{t('dataset.set.replaceHint')}</p>
      </label>
      <label className={styles.field}>
        <span>{t('dataset.set.prefix')}</span>
        <input value={form.prefix} maxLength={256} onChange={(e) => edit((f) => ({ ...f, prefix: e.target.value }))} />
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={form.normalizeUnderscores} onChange={(e) => edit((f) => ({ ...f, normalizeUnderscores: e.target.checked }))} />
        {t('dataset.set.underscores')}
      </label>
    </details>
  )
}
