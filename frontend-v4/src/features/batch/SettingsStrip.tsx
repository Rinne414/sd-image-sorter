import { useEffect, useRef } from 'react'
import type { Batch } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { useLayer } from '../../ui/layers'
import { CaptionPreview } from './CaptionPreview'
import { splitList, type DatasetForm } from './datasetSettings'
import styles from './DatasetSettings.module.css'
import { SettingsFields } from './SettingsFields'
import { setSettingsPanel, useSettingsPanel } from './settingsPanel'
import { useDatasetSettings, useTemplatePresets, type SaveState } from './useDatasetSettings'

const STATE: Record<SaveState, MessageKey> = {
  saved: 'dataset.state.saved',
  waiting: 'dataset.state.waiting',
  saving: 'dataset.state.saving',
  failed: 'dataset.state.failed',
}

const modelKey = (form: DatasetForm) => `dataset.model.${form.targetModel === '' ? 'none' : form.targetModel}` as MessageKey

/** One line: what the batch's captions are made with. */
function Summary({ form }: { form: DatasetForm }) {
  const t = useT()
  const common = splitList(form.commonTags).length
  const blacklist = splitList(form.blacklist).length
  return (
    <span className={styles.summary} data-testid="dataset-settings-summary">
      {form.trigger ? (
        <span>
          {t('dataset.set.trigger')} <b className="mono">{form.trigger}</b>
        </span>
      ) : (
        <span className={styles.warnText}>{t('dataset.sum.noTrigger')}</span>
      )}
      <span>
        {t('dataset.set.model')} <b>{t(modelKey(form))}</b>
      </span>
      <span>
        {t('dataset.set.purpose')} <b>{form.purpose ? t(`dataset.purpose.${form.purpose}` as MessageKey) : t('dataset.purpose.none')}</b>
        {form.removeCategories.length > 0 && ` · ${t('dataset.sum.categories', { n: form.removeCategories.length })}`}
      </span>
      <span>{t('dataset.sum.common', { n: common })}</span>
      <span>{t('dataset.sum.blacklist', { n: blacklist })}</span>
      <span>{form.maxTags > 0 ? t('dataset.sum.maxTags', { n: form.maxTags }) : t('dataset.sum.noMax')}</span>
    </span>
  )
}

/**
 * A dataset batch's training settings, in one place: a strip under the
 * batch head, and the panel it opens over the steps with the final caption
 * of every image beside the form.
 */
export function SettingsStrip({ batch }: { batch: Batch }) {
  const t = useT()
  const open = useSettingsPanel((st) => st.open)
  const setOpen = setSettingsPanel
  const s = useDatasetSettings(batch, open)
  const presets = useTemplatePresets()
  const triggerRef = useRef<HTMLInputElement>(null)
  // Esc closes the panel; a trigger still being typed counts, as it does on leaving the field.
  useLayer(open, () => {
    s.commitTrigger()
    setOpen(false)
  })

  // Opening puts the cursor in the trigger field, the one setting every dataset needs.
  useEffect(() => {
    if (open) triggerRef.current?.focus()
  }, [open])
  // Another batch opens with the panel closed.
  useEffect(() => () => setSettingsPanel(false), [batch.id])

  const form = s.form
  return (
    <>
      <div className={styles.strip} data-testid="dataset-settings-strip">
        <span className={styles.stripTitle}>{t('dataset.settings.title')}</span>
        {form ? <Summary form={form} /> : <span className={styles.summary}>{s.error ?? t('grid.loading')}</span>}
        <span className={styles.gap} />
        <span className={styles.state} data-state={s.state} aria-live="polite" data-testid="dataset-settings-state">
          {t(STATE[s.state])}
        </span>
        <button
          type="button"
          className={!open && form && !form.trigger ? 'btn btn-primary' : 'btn'}
          aria-expanded={open}
          onClick={() => {
            if (open) void s.flush()
            setOpen(!open)
          }}
          disabled={!form}
          data-testid="dataset-settings-open"
        >
          {open ? t('dataset.settings.close') : t('dataset.settings.open')}
        </button>
      </div>
      {open && form && (
        <section className={styles.panel} aria-label={t('dataset.settings.title')} data-testid="dataset-settings-panel">
          <SettingsFields
            s={s}
            form={form}
            presets={presets.data?.presets ?? []}
            variables={(presets.data?.variables ?? []).map((v) => v.name)}
            triggerRef={triggerRef}
          />
          <CaptionPreview s={s} />
        </section>
      )}
    </>
  )
}
