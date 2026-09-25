import { useLang, useT, type MessageKey } from '../i18n'
import { useApp, type Page } from '../state/store'
import styles from './TopBar.module.css'

const TABS: [Page, MessageKey][] = [
  ['library', 'nav.library'],
  ['batch', 'nav.batch'],
  ['sort', 'nav.sort'],
]

export function TopBar() {
  const t = useT()
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const setPaletteOpen = useApp((s) => s.setPaletteOpen)
  const lang = useLang((s) => s.lang)
  const setLang = useLang((s) => s.setLang)

  return (
    <header className={styles.bar}>
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

      <button type="button" className={styles.command} onClick={() => setPaletteOpen(true)} data-testid="open-palette">
        <span>{t('nav.command')}</span>
        <kbd>Ctrl K</kbd>
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

/** A single film frame with sprocket holes: the app's mark. */
function FrameMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className={styles.mark}>
      <rect x="1" y="3" width="20" height="16" rx="2" fill="currentColor" opacity="0.18" />
      <rect x="5" y="6.5" width="12" height="9" rx="1" fill="currentColor" />
      {[3, 7, 11, 15].map((x) => (
        <g key={x} fill="var(--bg)">
          <rect x={x + 0.5} y="3.8" width="2" height="1.4" rx="0.3" />
          <rect x={x + 0.5} y="16.8" width="2" height="1.4" rx="0.3" />
        </g>
      ))}
    </svg>
  )
}
