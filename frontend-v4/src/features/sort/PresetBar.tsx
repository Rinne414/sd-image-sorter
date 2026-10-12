import { useRef, useState } from 'react'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { Icon } from '../../ui/Icon'
import { useToasts } from '../../ui/toasts'
import type { SortSetup } from './savedSetup'
import { MODE_NAME } from './SetupParts'
import { SortConfirm } from './SortConfirm'
import { deletePreset, loadPresets, presetSetup, savePreset, type SortPreset } from './sortPrefs'
import styles from './SortPage.module.css'

interface Props {
  libraryId: string
  setup: SortSetup
  onLoad: (setup: SortSetup) => void
}

/** Named setups of this library: click one to load it, save the current one, delete one (asked first). */
export function PresetBar({ libraryId, setup, onLoad }: Props) {
  const t = useT()
  const [presets, setPresets] = useState(() => loadPresets(libraryId))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<SortPreset | null>(null)
  const say = (text: string) => useToasts.getState().push(text, 'info')

  const load = (preset: SortPreset) => {
    onLoad(presetSetup(preset))
    say(t('sort.preset.loaded', { name: preset.name }))
  }

  return (
    <div className={styles.presets} data-testid="sort-presets">
      <span className={styles.presetsLabel}>{t('sort.preset.title')}</span>
      {presets.length === 0 && <span className={styles.note}>{t('sort.preset.none')}</span>}
      {presets.map((p) => (
        <span key={p.name} className={styles.preset} data-preset={p.name}>
          <button type="button" className={styles.presetLoad} onClick={() => load(p)} title={t('sort.preset.load', { name: p.name })}>
            {p.name}
            <span className={styles.presetMode}>{t(MODE_NAME[p.mode])}</span>
          </button>
          <button type="button" className={styles.presetDelete} onClick={() => setDeleting(p)} aria-label={t('sort.preset.delete', { name: p.name })} title={t('sort.preset.delete', { name: p.name })}>
            <Icon name="close" size={11} />
          </button>
        </span>
      ))}
      <button type="button" className="btn btn-ghost" onClick={() => setSaving(true)} data-testid="sort-preset-save">
        {t('sort.preset.save')}
      </button>
      {saving && (
        <SaveDialog
          taken={presets.map((p) => p.name)}
          onSave={(name) => {
            setPresets(savePreset(libraryId, name, setup))
            say(t('sort.preset.saved', { name }))
          }}
          onClose={() => setSaving(false)}
        />
      )}
      {deleting && (
        <SortConfirm
          title={t('sort.preset.deleteTitle')}
          body={t('sort.preset.deleteBody', { name: deleting.name })}
          confirmLabel={t('sort.preset.deleteOk')}
          onConfirm={async () => setPresets(deletePreset(libraryId, deleting.name))}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

function SaveDialog({ taken, onSave, onClose }: { taken: string[]; onSave: (name: string) => void; onClose: () => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmed = name.trim()
  const replaces = taken.includes(trimmed)
  const save = () => {
    if (!trimmed) return
    onSave(trimmed)
    onClose()
  }
  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={save} disabled={!trimmed} data-testid="sort-preset-confirm">
        {t(replaces ? 'sort.preset.replaceOk' : 'sort.preset.saveOk')}
      </button>
    </>
  )
  return (
    <Dialog title={t('sort.preset.saveTitle')} onClose={onClose} footer={footer} initialFocus={inputRef} testId="sort-preset-dialog">
      <p className={styles.confirmBody}>{t('sort.preset.saveBody')}</p>
      <label className={styles.nameField}>
        <span>{t('sort.preset.name')}</span>
        <input
          ref={inputRef}
          value={name}
          placeholder={t('sort.preset.nameHint')}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            }
          }}
          data-testid="sort-preset-name"
        />
      </label>
      {replaces && <p className={styles.warn}>{t('sort.preset.exists', { name: trimmed })}</p>}
    </Dialog>
  )
}
