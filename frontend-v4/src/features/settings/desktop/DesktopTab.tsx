import { useState, type KeyboardEvent } from 'react'
import { useT } from '../../../i18n'
import { useToasts } from '../../../ui/toasts'
import { Section } from '../about/Section'
import { SettingRow } from '../SettingRow'
import styles from './Desktop.module.css'
import { acceleratorFrom, DEFAULT_SHORTCUT, displayShortcut } from './shortcut'
import { useDesktopProgram } from './desktopProgram'
import { openQuickCollect, type DesktopSettings } from './shell'
import { useDesktopSettings } from './useDesktopSettings'

/**
 * Settings › Desktop: start at login, keep running in the tray, the global
 * shortcut (only inside the desktop program's window; a browser is told so),
 * and the Quick collect window (both).
 */
export function DesktopTab() {
  const t = useT()
  const { shell, settings, change } = useDesktopSettings()

  return (
    <div className={styles.sections}>
      {shell ? (
        <Section title={t('desktop.program.title')} testId="desktop-program">
          {settings ? <ProgramRows settings={settings} change={change} /> : <p className={styles.state}>{t('desktop.reading')}</p>}
        </Section>
      ) : (
        <Section title={t('desktop.browser.title')} testId="desktop-browser-note">
          <p className={styles.lead}>{t('desktop.browser.body')}</p>
          <WhereIsTheProgram />
        </Section>
      )}
      <Section title={t('desktop.collect.title')} testId="desktop-collect">
        <SettingRow title={t('desktop.collect.title')} body={t('desktop.collect.body')}>
          <button type="button" className="btn" onClick={openQuickCollect} data-testid="desktop-quick-collect">
            {t('desktop.collect.open')}
          </button>
        </SettingRow>
        {!shell && <p className={styles.hint}>{t('desktop.browser.collectNote')}</p>}
      </Section>
    </div>
  )
}

/** In a browser on Windows: where the desktop program is, or how to get it (in-app updates never install it). */
function WhereIsTheProgram() {
  const t = useT()
  const { data } = useDesktopProgram(true)
  if (!data?.windows) return null
  if (data.installed) {
    return (
      <p className={styles.hint} data-testid="desktop-program-here">
        {t('desktop.browser.here')}
      </p>
    )
  }
  return (
    <div className={styles.missing} data-testid="desktop-program-missing">
      <p className={styles.hint}>{t('desktop.browser.missing')}</p>
      <a className="btn" href={data.download_url} target="_blank" rel="noopener noreferrer" data-testid="desktop-program-download">
        {t('desktop.browser.download')}
      </a>
    </div>
  )
}

interface RowsProps {
  settings: DesktopSettings
  change: (key: 'startAtLogin' | 'closeToTray' | 'shortcut', value: boolean | string) => Promise<string | null>
}

function ProgramRows({ settings, change }: RowsProps) {
  const t = useT()
  const apply = async (key: 'startAtLogin' | 'closeToTray' | 'shortcut', value: boolean | string) => {
    const problem = await change(key, value)
    if (problem) useToasts.getState().push(t('desktop.setting.failed', { error: problem }), 'error')
  }
  return (
    <>
      <SettingRow title={t('desktop.login.title')} body={t('desktop.login.body')} testId="desktop-login-row">
        <Toggle on={settings.startAtLogin} onToggle={() => void apply('startAtLogin', !settings.startAtLogin)} testId="desktop-login" />
      </SettingRow>
      <SettingRow title={t('desktop.close.title')} body={t('desktop.close.body')} testId="desktop-close-row">
        <Toggle on={settings.closeToTray} onToggle={() => void apply('closeToTray', !settings.closeToTray)} testId="desktop-close" />
      </SettingRow>
      <ShortcutRow settings={settings} onSet={(value) => void apply('shortcut', value)} />
    </>
  )
}

/** The state shown is the state the button has now, like every switch in V Opus: it flips on click. */
function Toggle({ on, onToggle, testId }: { on: boolean; onToggle: () => void; testId: string }) {
  const t = useT()
  return (
    <button type="button" className="btn" aria-pressed={on} onClick={onToggle} data-testid={testId}>
      {t(on ? 'desktop.on' : 'desktop.off')}
    </button>
  )
}

function shortcutNote(settings: DesktopSettings): { key: 'desktop.shortcut.body' | 'desktop.shortcut.refused' | 'desktop.shortcut.invalid'; bad: boolean } {
  if (settings.shortcutOk) return { key: 'desktop.shortcut.body', bad: false }
  return { key: settings.shortcutReason === 'refused' ? 'desktop.shortcut.refused' : 'desktop.shortcut.invalid', bad: true }
}

function ShortcutRow({ settings, onSet }: { settings: DesktopSettings; onSet: (accelerator: string) => void }) {
  const t = useT()
  // What the user just pressed shows until the shell answers or the box loses focus.
  const [typed, setTyped] = useState<string | null>(null)
  const note = shortcutNote(settings)

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      // Esc leaves the box; it closes nothing else.
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.blur()
      return
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return
    e.preventDefault()
    const accelerator = acceleratorFrom(e)
    if (!accelerator) return
    setTyped(accelerator)
    onSet(accelerator)
  }

  return (
    <SettingRow
      title={t('desktop.shortcut.title')}
      body={
        <span className={note.bad ? styles.bad : undefined} role={note.bad ? 'alert' : undefined} data-testid="desktop-shortcut-note">
          {t(note.key)}
        </span>
      }
      testId="desktop-shortcut-row"
    >
      <input
        className={`${styles.shortcut} mono`}
        value={displayShortcut(typed ?? settings.shortcut)}
        readOnly
        spellCheck={false}
        autoComplete="off"
        aria-label={t('desktop.shortcut.label')}
        onKeyDown={onKeyDown}
        onBlur={() => setTyped(null)}
        data-testid="desktop-shortcut"
      />
      <button type="button" className="btn btn-ghost" onClick={() => onSet(DEFAULT_SHORTCUT)} data-testid="desktop-shortcut-reset">
        {t('desktop.shortcut.reset')}
      </button>
    </SettingRow>
  )
}
