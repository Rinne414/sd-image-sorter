import { useLang, useT, type MessageKey } from '../i18n'
import { useApp, type Page } from '../state/store'
import { useTheme, type ThemeMode } from '../theme'
import { Icon } from '../ui/Icon'
import { JobsMenu } from '../features/jobs/JobsMenu'
import { useSelectionDialog } from '../features/selection/dialogs'
import styles from './TopBar.module.css'

const TABS: [Page, MessageKey][] = [
  ['library', 'nav.library'],
  ['batch', 'nav.batch'],
  ['sort', 'nav.sort'],
]

const THEME_LABEL: Record<ThemeMode, MessageKey> = {
  dark: 'theme.dark',
  light: 'theme.light',
  system: 'theme.system',
}

export function TopBar() {
  const t = useT()
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const setPaletteOpen = useApp((s) => s.setPaletteOpen)
  const lang = useLang((s) => s.lang)
  const setLang = useLang((s) => s.setLang)
  const mode = useTheme((s) => s.mode)
  const theme = useTheme((s) => s.theme)
  const cycleTheme = useTheme((s) => s.cycle)

  return (
    <header className={styles.bar}>
      <button type="button" className={styles.skip} onClick={skipToContent} data-testid="skip-link">
        {t('browse.skip')}
      </button>
      <button type="button" className={styles.brand} onClick={() => setPage('home')} aria-label={t('nav.home')} title={t('nav.home')}>
        <FrameMark />
        <span className={styles.brandName}>SD Image Sorter</span>
        <span className={`${styles.version} mono`}>V4</span>
      </button>

      <nav className={styles.tabs} aria-label="main">
        {TABS.map(([id, key]) => (
          <button
            key={id}
            type="button"
            className={styles.tab}
            aria-current={page === id ? 'page' : undefined}
            onClick={() => setPage(id)}
          >
            {t(key)}
          </button>
        ))}
      </nav>

      <span className={styles.gap} />

      <JobsMenu />
      <button
        type="button"
        className="btn"
        onClick={() => useSelectionDialog.getState().showFor('import', null, 1)}
        data-testid="import-button"
      >
        {t('import.button')}
      </button>
      <button type="button" className={styles.command} onClick={() => setPaletteOpen(true)} data-testid="open-palette">
        <Icon name="search" size={14} />
        <span className={styles.commandText}>{t('nav.command')}</span>
        <kbd>Ctrl K</kbd>
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        onClick={cycleTheme}
        title={t('theme.current', { name: t(THEME_LABEL[mode]) })}
        aria-label={t('theme.current', { name: t(THEME_LABEL[mode]) })}
        data-testid="theme-toggle"
      >
        <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setLang(lang === 'zh-CN' ? 'en' : 'zh-CN')}>
        {t('nav.language')}
      </button>
      <a className="btn btn-ghost" href="/">
        {t('nav.backToV3')}
      </a>
    </header>
  )
}

/**
 * Past the top bar to the page's own content. A button, not a #link: the
 * address hash is the app's route.
 */
function skipToContent(): void {
  const target = document.querySelector<HTMLElement>('main') ?? document.querySelector<HTMLElement>('header + *')
  if (!target) return
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
  target.focus()
}

/** A single frame of film with its sprocket holes: the app's mark. */
function FrameMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className={styles.mark}>
      <rect x="1.5" y="3.5" width="19" height="15" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="5.5" y="7" width="11" height="8" fill="currentColor" />
      {[3.2, 7.2, 11.2, 15.2].map((x) => (
        <g key={x} fill="currentColor">
          <rect x={x} y="4.6" width="2" height="1.2" />
          <rect x={x} y="16.2" width="2" height="1.2" />
        </g>
      ))}
    </svg>
  )
}
