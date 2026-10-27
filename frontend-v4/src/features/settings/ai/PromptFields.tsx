import { useId } from 'react'
import styles from './Ai.module.css'
import { useAT } from './aiText'
import { PresetBar } from './PresetBar'
import type { VlmDraft } from './useVlmDraft'

/** What the model is asked to write: a preset, the prompts and whether tags go along. */
export function PromptFields({ draft }: { draft: VlmDraft }) {
  const t = useAT()
  const systemId = useId()
  const userId = useId()
  const withTagsId = useId()
  const { form, set } = draft


  return (
    <div className={styles.group}>
      <h4 className={styles.groupTitle}>{t('ai.prompts')}</h4>
      <PresetBar draft={draft} />
      <div className={styles.field}>
        <label className={styles.label} htmlFor={systemId}>
          {t('ai.system')}
        </label>
        <textarea id={systemId} className={styles.textarea} rows={3} value={form.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} data-testid="vlm-system" />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={userId}>
          {t('ai.user')}
        </label>
        <textarea id={userId} className={styles.textarea} rows={3} value={form.userPrompt} onChange={(e) => set({ userPrompt: e.target.value })} data-testid="vlm-user" />
      </div>
      <label className={styles.check}>
        <input type="checkbox" checked={form.includeTags} onChange={(e) => set({ includeTags: e.target.checked })} data-testid="vlm-include-tags" />
        {t('ai.includeTags')}
      </label>
      {form.includeTags && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={withTagsId}>
            {t('ai.userWithTags')}
          </label>
          <textarea
            id={withTagsId}
            className={styles.textarea}
            rows={3}
            value={form.userPromptWithTags}
            onChange={(e) => set({ userPromptWithTags: e.target.value })}
            data-testid="vlm-user-tags"
          />
        </div>
      )}
    </div>
  )
}
