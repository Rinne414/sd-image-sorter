import { useId, useState } from 'react'
import styles from './Ai.module.css'
import { usePresets } from './aiApi'
import { isAiKey, useAT } from './aiText'
import type { Preset } from './types'
import type { VlmDraft } from './useVlmDraft'
import { applyPreset } from './vlmForm'

/** What the model is asked to write: a preset, the prompts and whether tags go along. */
export function PromptFields({ draft }: { draft: VlmDraft }) {
  const t = useAT()
  const presetId = useId()
  const systemId = useId()
  const userId = useId()
  const withTagsId = useId()
  const presets = usePresets()
  const [chosen, setChosen] = useState('')
  const [applied, setApplied] = useState<string | null>(null)
  const { form, set } = draft

  const presetName = (id: string, p: Preset) => {
    const key = `ai.preset.${id}`
    return isAiKey(key) ? t(key) : p.name
  }
  const apply = () => {
    const preset = presets.data?.[chosen]
    if (!preset) return
    set((f) => applyPreset(f, preset))
    setApplied(presetName(chosen, preset))
  }

  return (
    <div className={styles.group}>
      <h4 className={styles.groupTitle}>{t('ai.prompts')}</h4>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={presetId}>
          {t('ai.preset')}
        </label>
        <div className={styles.inline}>
          <select id={presetId} className={styles.select} value={chosen} onChange={(e) => setChosen(e.target.value)} data-testid="vlm-preset">
            <option value="">{t('ai.preset.choose')}</option>
            {Object.entries(presets.data ?? {}).map(([id, p]) => (
              <option key={id} value={id}>
                {presetName(id, p)}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={apply} disabled={!chosen} data-testid="vlm-preset-apply">
            {t('ai.preset.apply')}
          </button>
        </div>
        {applied && (
          <p className={styles.note} data-tone="info" role="status" data-testid="vlm-preset-note">
            {t('ai.preset.applied', { name: applied })}
          </p>
        )}
      </div>
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
