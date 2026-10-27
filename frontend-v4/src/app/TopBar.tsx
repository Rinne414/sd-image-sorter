import { useRef } from 'react'
import { useT, type MessageKey } from '../i18n'
import { useApp } from '../state/store'
import { useTheme, type ThemeMode } from '../theme'
import { FrameMark } from '../ui/FrameMark'
import { Icon } from '../ui/Icon'
import { AiBusyChip } from '../features/jobs/AiBusyChip'
import { JobsMenu } from '../features/jobs/JobsMenu'
import { useSelectionDialog } from '../features/selection/dialogs'
import { UpdateHint } from '../features/settings/about/UpdateHint'
import { NavCustomizeDialog } from '../features/navcustom/NavCustomizeDialog'
import { hiddenIds, shownIds } from '../features/navcustom/navChoice'
import { useNavCustomizeOpen } from '../features/navcustom/navStore'
import { ToolsMenu } from '../features/tools/ToolsMenu'
import { Menu, type MenuItem } from '../ui/Menu'
import { placeIsCurrent, TOPBAR_PLACES, useTopBarNav, type TopBarPlace } from './topBarPlaces'
import styles from './TopBar.module.css'
import { useTightBar } from './useTightBar'

const PLACE_BY_ID = new Map<string, TopBarPlace>(TOPBAR_PLACES.map((p) => [p.id, p]))

function goTo(place: TopBarPlace): void {
  const app = useApp.getState()
  if (place.tool) app.openTool(place.tool)
  else app.setPage(place.page)
}

const THEME_LABEL: Record<ThemeMode, MessageKey> = {
  dark: 'theme.dark',
  light: 'theme.light',
  system: 'theme.system',
}

/**
 * Logo, the places the user keeps in the bar (library, batch and sort until
 * they customize it; hidden pages wait under More, the Reader in Tools), then: AI busy and a new version (only when there is
 * one), jobs, import, Ctrl K, Tools, Settings, theme, back to V3.5. On the
 * settings and tools pages no tab is lit; ⚙ or Tools is.
 */
export function TopBar() {
  const t = useT()
  const page = useApp((s) => s.page)
  const toolId = useApp((s) => s.toolId)
  const choice = useTopBarNav((s) => s.choice)
  const customizeOpen = useNavCustomizeOpen((s) => s.open)
  const setCustomizeOpen = useNavCustomizeOpen((s) => s.setOpen)
  const setPage = useApp((s) => s.setPage)
  const setPaletteOpen = useApp((s) => s.setPaletteOpen)
  const openSettings = useApp((s) => s.openSettings)
  const mode = useTheme((s) => s.mode)
  const theme = useTheme((s) => s.theme)
  const cycleTheme = useTheme((s) => s.cycle)
  const brandRef = useRef<HTMLButtonElement>(null)
  const gapRef = useRef<HTMLSpanElement>(null)
  const importRef = useRef<HTMLButtonElement>(null)
  // short of room (every place in the bar, a wide font): the brand keeps only its mark
  const tight = useTightBar(gapRef, importRef, brandRef)

  const places = (ids: string[]) => ids.map((id) => PLACE_BY_ID.get(id)).filter((p): p is TopBarPlace => !!p)
  const tabs = places(shownIds(choice))
  // a hidden tool is in the Tools menu already, so More only shows for hidden pages
  const tucked = places(hiddenIds(choice)).filter((p) => !p.inTools)
  const moreItems: MenuItem[] = [
    ...tucked.map((p) => ({
      id: `place-${p.id}`,
      label: t(p.label),
      checked: placeIsCurrent(p, page, toolId),
      onSelect: () => goTo(p),
    })),
    { id: 'customize-places', label: t('navcustom.open'), divider: true, onSelect: () => setCustomizeOpen(true) },
  ]
  const labels = Object.fromEntries(TOPBAR_PLACES.map((p) => [p.id, t(p.label)]))

  return (
    <>
      <header
        className={styles.bar}
        data-tight={tight || undefined}
        onContextMenu={(e) => {
          e.preventDefault()
          setCustomizeOpen(true)
        }}
      >
        <button type="button" className={styles.skip} onClick={skipToContent} data-testid="skip-link">
          {t('browse.skip')}
        </button>
        <button ref={brandRef} type="button" className={styles.brand} onClick={() => setPage('home')} aria-label={t('nav.home')} title={t('nav.home')}>
          <FrameMark className={styles.mark} />
          <span className={styles.brandName}>SD Image Sorter</span>
          <span className={`${styles.version} mono`}>Vopus</span>
        </button>

        <nav className={styles.tabs} aria-label="main">
          {tabs.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.tab}
              aria-current={placeIsCurrent(p, page, toolId) ? 'page' : undefined}
              onClick={() => goTo(p)}
              data-testid={`topbar-place-${p.id}`}
            >
              {t(p.label)}
            </button>
          ))}
        </nav>
        {tucked.length > 0 && (
          <Menu
            label={t('navcustom.more')}
            title={t('navcustom.moreTitle')}
            items={moreItems}
            current={tucked.some((p) => placeIsCurrent(p, page, toolId))}
            testId="topbar-more"
          />
        )}

        <span ref={gapRef} className={styles.gap} />

        <AiBusyChip />
        <UpdateHint />
        <JobsMenu />
        <button
          ref={importRef}
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
        <ToolsMenu />
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => openSettings()}
          aria-current={page === 'settings' ? 'page' : undefined}
          title={t('settings.gear')}
          aria-label={t('settings.title')}
          data-testid="settings-button"
        >
          <Icon name="gear" />
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
      </header>
      {customizeOpen && <NavCustomizeDialog useStore={useTopBarNav} defs={TOPBAR_PLACES} labels={labels} onClose={() => setCustomizeOpen(false)} />}
    </>
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
