import { isSitePassword } from './engine/password'
import styles from './Privacy.module.css'
import { usePT, type PrivacyKey } from './privacyText'
import { setOptions, setPassword, usePrivacy, type PrivacyMode } from './privacyStore'

// The left column: what the tool does, the mode, the password, and whether
// the generation details travel. Locked while a run goes on (the run took the
// settings when it started).

const MODES: PrivacyMode[] = ['standard', 'simple']

function Modes({ mode }: { mode: PrivacyMode }) {
  const t = usePT()
  return (
    <fieldset className={styles.modes}>
      <legend className={styles.subLabel}>{t('privacy.mode')}</legend>
      {MODES.map((m) => (
        <label key={m} className={styles.mode}>
          <input type="radio" name="privacy-mode" checked={mode === m} onChange={() => setOptions({ mode: m })} data-testid={`privacy-mode-${m}`} />
          <span>
            <span className={styles.modeName}>{t(`privacy.mode.${m}` as PrivacyKey)}</span>
            <span className={styles.hint}>{t(`privacy.mode.${m}.hint` as PrivacyKey)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

function PasswordField() {
  const t = usePT()
  const password = usePrivacy((s) => s.password)
  return (
    <label className={styles.field} data-testid="privacy-password-field">
      <span className={styles.subLabel}>{t('privacy.password')}</span>
      <input
        className={styles.text}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        value={password}
        placeholder={t('privacy.passwordPlaceholder')}
        onChange={(e) => setPassword(e.target.value)}
        data-testid="privacy-password"
      />
      <span className={styles.hint}>{t('privacy.passwordHint')}</span>
      {!isSitePassword(password) && (
        <span className={styles.warnText} data-testid="privacy-password-offsite">
          {t('privacy.passwordOffSite')}
        </span>
      )}
    </label>
  )
}

function Check({ checked, onChange, label, hint, testId }: { checked: boolean; onChange: (on: boolean) => void; label: PrivacyKey; hint: PrivacyKey; testId: string }) {
  const t = usePT()
  return (
    <label className={styles.check}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span>
        <span className={styles.modeName}>{t(label)}</span>
        <span className={styles.hint}>{t(hint)}</span>
      </span>
    </label>
  )
}

export function SettingsPanel() {
  const t = usePT()
  const options = usePrivacy((s) => s.options)
  const running = usePrivacy((s) => s.run !== null)

  return (
    <aside className={styles.settings} data-testid="privacy-settings">
      <p className={styles.what} data-testid="privacy-what">
        {t('privacy.what')}
      </p>
      <fieldset className={styles.fields} disabled={running}>
        <Modes mode={options.mode} />
        {options.mode === 'standard' && <PasswordField />}
        <Check checked={options.keepInfo} onChange={(keepInfo) => setOptions({ keepInfo })} label="privacy.keepInfo" hint="privacy.keepInfo.hint" testId="privacy-keep-info" />
        {options.mode === 'simple' && (
          <p className={styles.note} data-testid="privacy-jpeg-note">
            {t('privacy.jpegNote')}
          </p>
        )}
        <details className={styles.advanced} open={options.advancedOpen} onToggle={(e) => setOptions({ advancedOpen: e.currentTarget.open })}>
          <summary className={styles.summary} data-testid="privacy-advanced">
            {t('privacy.advanced')}
          </summary>
          <Check checked={options.legacyInfo} onChange={(legacyInfo) => setOptions({ legacyInfo })} label="privacy.legacyInfo" hint="privacy.legacyInfo.hint" testId="privacy-legacy-info" />
        </details>
      </fieldset>
      {running && <p className={styles.hint}>{t('privacy.runningLocked')}</p>}
    </aside>
  )
}
