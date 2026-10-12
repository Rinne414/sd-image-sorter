import { useState } from 'react'
import { useT } from '../../../../i18n'
import { Dialog } from '../../../../ui/Dialog'
import { useToasts } from '../../../../ui/toasts'
import { tr } from '../../../jobs/jobs'
import { plt, usePL } from '../plText'
import type { PromptPreset } from '../types'
import styles from './Random.module.css'
import { deletePreset, savePreset } from './randomApi'
import { setRandom, useRandom } from './randomStore'
import { readSetup, setupConfig } from './setup'

// 预设: the whole Random setup saved under a name (V3.5's own preset format,
// so presets saved in either app load in the other).

function SaveDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const p = usePL()
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const submit = async () => {
    const clean = name.trim()
    if (!clean) return
    try {
      await savePreset(clean, setupConfig(useRandom.getState()))
      useToasts.getState().push(plt('pl.rnd.presetSaved', { name: clean }))
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
      <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!name.trim()} data-testid="pl-preset-confirm">
        {p('pl.rnd.save')}
      </button>
    </>
  )
  return (
    <Dialog title={p('pl.rnd.presetSave')} onClose={onClose} footer={footer} testId="pl-preset-dialog">
      <label className={styles.field}>
        <span className={styles.subLabel}>{p('pl.rnd.presetName')}</span>
        <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} data-testid="pl-preset-name" />
      </label>
      {problem && <p className={styles.problem}>{problem}</p>}
    </Dialog>
  )
}

/** Loading replaces the setup; Undo brings the one before back. */
function loadPreset(preset: PromptPreset): void {
  const before = setupConfig(useRandom.getState())
  setRandom(readSetup(preset.config))
  useToasts.getState().push(plt('pl.rnd.presetLoaded', { name: preset.name }), 'info', { label: tr('toast.undo'), run: () => setRandom(readSetup(before)) })
}

/** Delete a preset; Undo saves it again. */
async function removePreset(preset: PromptPreset): Promise<void> {
  try {
    await deletePreset(preset.id)
  } catch (error) {
    useToasts.getState().push(plt('pl.rnd.deleteFailed', { reason: (error as Error).message }), 'error')
    return
  }
  useToasts.getState().push(plt('pl.rnd.presetDeleted', { name: preset.name }), 'info', { label: tr('toast.undo'), run: () => void savePreset(preset.name, preset.config) })
}

export function Presets({ presets }: { presets: PromptPreset[] }) {
  const p = usePL()
  const [saving, setSaving] = useState(false)
  return (
    <section className={styles.panel} data-testid="pl-presets">
      <header className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{p('pl.rnd.presets')}</h3>
        <button type="button" className="btn" onClick={() => setSaving(true)} data-testid="pl-preset-save">
          {p('pl.rnd.presetSave')}
        </button>
      </header>
      <p className={styles.muted}>{p('pl.rnd.presetsLead')}</p>
      {presets.length === 0 ? (
        <p className={styles.muted}>{p('pl.rnd.presetNone')}</p>
      ) : (
        <ul className={styles.list}>
          {presets.map((preset) => (
            <li key={preset.id} className={styles.listRow} data-preset={preset.name}>
              <div className={styles.listHead}>
                <span className={styles.listName}>{preset.name}</span>
                {preset.created_at && <span className={`${styles.muted} mono`}>{preset.created_at.slice(0, 16)}</span>}
                <span className={styles.listActions}>
                  <button type="button" className={styles.textButton} onClick={() => loadPreset(preset)} data-action="load">
                    {p('pl.rnd.presetLoad')}
                  </button>
                  <button type="button" className={styles.textButton} onClick={() => void removePreset(preset)} data-action="delete">
                    {p('pl.rnd.delete')}
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {saving && <SaveDialog onClose={() => setSaving(false)} />}
    </section>
  )
}
