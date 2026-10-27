import { useRef, type ReactNode } from 'react'
import { useT, type MessageKey } from '../i18n'
import { useApp } from '../state/store'
import { FrameMark } from '../ui/FrameMark'
import { Icon } from '../ui/Icon'
import { Menu, type MenuItem } from '../ui/Menu'
import { useToasts } from '../ui/toasts'
import { AiBusyChip } from '../features/jobs/AiBusyChip'
import { JobsMenu } from '../features/jobs/JobsMenu'
import { NavCustomizeDialog } from '../features/navcustom/NavCustomizeDialog'
import { hiddenIds, shownIds } from '../features/navcustom/navChoice'
import { useNavCustomizeOpen } from '../features/navcustom/navStore'
import { useSelectionDialog } from '../features/selection/dialogs'
import { useAppStats } from '../features/settings/about/aboutApi'
import { UpdateHint } from '../features/settings/about/UpdateHint'
import { useSimilarDialogs } from '../features/similar/dialogs'
import { TOOLS } from '../features/tools/registry'
import { findLoadedImage } from '../api/loaded'
import { quickCensor } from '../features/censor/quickCensor'
import { pickImageFile } from '../features/similar/imageSearch'
import { showLikeImage, useSimilar } from '../features/similar/similarStore'
import { openClassic } from './classicLink'
import { NEXT_PLACES, useNextNav } from './nextPlaces'
import styles from './NextTopBar.module.css'
import { useTightBar } from '../app/useTightBar'

interface Place {
  id: string
  label: MessageKey
  current: boolean
  go: () => void
  /** Opens that page of the classic interface (not built here yet). */
  classic?: boolean
}

/** The images a tool acts on: the picks, else the image being looked at. */
function targetIds(): number[] {
  const s = useApp.getState()
  if (s.selection.length > 0) return [...s.selection]
  return s.inspectedId !== null ? [s.inspectedId] : []
}

const app = () => useApp.getState()

/** Tools that are places of their own in the bar (not repeated in More). */
const BAR_TOOLS: ReadonlySet<string> = new Set(['reader', 'stylemap'])

/**
 * The top edge of the new interface (docs/DESIGN.md §redesign-2026-10): the
 * name with its version, every place as a labelled tab, then background work,
 * Ctrl K, AI tagging, Import and Settings.
 */
export function NextTopBar() {
  const t = useT()
  const page = useApp((s) => s.page)
  const toolId = useApp((s) => s.toolId)
  const picks = useApp((s) => s.selection.length)
  const stats = useAppStats()
  const choice = useNextNav((s) => s.choice)
  const customizeOpen = useNavCustomizeOpen((s) => s.open)
  const setCustomizeOpen = useNavCustomizeOpen((s) => s.setOpen)
  const brandRef = useRef<HTMLButtonElement>(null)
  const gapRef = useRef<HTMLSpanElement>(null)
  const findRef = useRef<HTMLButtonElement>(null)
  // short of room (every place in the bar, a wide font): the app's mark stands in for the name
  const tight = useTightBar(gapRef, findRef, brandRef)

  const places: Place[] = [
    { id: 'library', label: 'next.place.library', current: page === 'library', go: () => app().setPage('library') },
    { id: 'batch', label: 'next.place.batch', current: page === 'batch', go: () => app().setPage('batch') },
    { id: 'sort', label: 'next.place.sort', current: page === 'sort', go: () => app().setPage('sort') },
    { id: 'reader', label: 'next.place.reader', current: page === 'tools' && toolId === 'reader', go: () => app().openTool('reader') },
    { id: 'stylemap', label: 'next.place.stylemap', current: page === 'tools' && toolId === 'stylemap', go: () => app().openTool('stylemap') },
  ]

  const onImages = (run: (ids: number[]) => void) => () => {
    const ids = targetIds()
    if (ids.length === 0) useToasts.getState().push(t('tools.pickFirst'))
    else run(ids)
  }

  // Censoring here is a batch's censor step; the picks become one at once.
  const inspectedId = useApp.getState().inspectedId
  const censorItems: MenuItem[] = [
    {
      id: 'censor-picks',
      label: picks > 0 ? t('next.censor.picks', { n: picks }) : inspectedId !== null ? t('next.censor.one') : t('next.censor.pickFirst'),
      onSelect: onImages((ids) => void quickCensor(ids)),
    },
    { id: 'censor-batches', label: t('next.censor.batches'), onSelect: () => app().setPage('batch') },
    { id: 'censor-classic', label: t('next.censor.classic'), hint: t('next.place.classicHint'), divider: true, onSelect: () => openClassic('censor') },
  ]
  // Similar images are a ranking of the library itself.
  const similarItems: MenuItem[] = [
    { id: 'similar-image', label: t('next.similar.byImage'), onSelect: () => { app().setPage('library'); pickImageFile() } },
    {
      id: 'similar-meaning',
      label: t('next.similar.byMeaning'),
      onSelect: () => {
        app().setPage('library')
        useSimilar.getState().setSemantic(true)
      },
    },
    {
      id: 'similar-this',
      label: t('next.similar.likeThis'),
      onSelect: onImages((ids) => {
        const id = ids[0]!
        app().setPage('library')
        showLikeImage(id, findLoadedImage(id)?.filename ?? '', false)
      }),
    },
    { id: 'similar-dup', label: t('next.more.duplicates'), onSelect: () => useSimilarDialogs.getState().setDuplicates(true) },
    { id: 'similar-classic', label: t('next.similar.classic'), hint: t('next.place.classicHint'), divider: true, onSelect: () => openClassic('similar') },
  ]

  // Places the user took out of the bar wait at the top of More: single places
  // first, then the items of a hidden Censor or Similar menu under its name.
  const hiddenSet = new Set(hiddenIds(choice))
  const hiddenMenus: Record<string, MenuItem[]> = { censor: censorItems, similar: similarItems }
  const hiddenPlaces: MenuItem[] = places
    .filter((p) => hiddenSet.has(p.id))
    .map((p) => ({ id: `place-${p.id}`, label: t(p.label), checked: p.current, group: t('navcustom.hiddenGroup'), onSelect: p.go }))
  const hiddenGroups: MenuItem[] = Object.entries(hiddenMenus)
    .filter(([id]) => hiddenSet.has(id))
    .flatMap(([id, items]) => items.map((item) => ({ ...item, group: t(`next.place.${id}` as MessageKey), divider: undefined })))
  const hiddenItems = [...hiddenPlaces, ...hiddenGroups]
  const hiddenCurrent = places.some((p) => hiddenSet.has(p.id) && p.current)

  const more: MenuItem[] = [
    ...hiddenItems,
    // Reader and Style Map are places in the bar; More lists the other tools.
    ...TOOLS.filter((tool) => !BAR_TOOLS.has(tool.id)).map((tool, i) => ({
      id: `tool-${tool.id}`,
      divider: i === 0 && hiddenItems.length > 0 ? true : undefined,
      label: t(tool.label),
      checked: page === 'tools' && toolId === tool.id,
      onSelect: () => app().openTool(tool.id),
    })),
    {
      id: 'edit-tags',
      label: picks > 1 ? t('tools.editTagsMany', { n: picks }) : t('tools.editTags'),
      divider: true,
      onSelect: onImages((ids) => useSelectionDialog.getState().showFor('edit-tags', ids, ids.length)),
    },
    { id: 'customize-places', label: t('navcustom.open'), divider: true, onSelect: () => setCustomizeOpen(true) },
    // A new dataset batch, as Home's Dataset card makes one: pick in the library, the banner there makes the batch.
    {
      id: 'dataset',
      label: t('next.more.dataset'),
      divider: true,
      onSelect: () => {
        app().setAdding({ kind: 'dataset' })
        app().setPage('library')
      },
    },
    { id: 'classic', label: t('next.more.classicUi'), divider: true, onSelect: () => openClassic() },
    { id: 'vopus', label: t('next.more.vopusUi'), onSelect: () => location.assign('/vopus/') },
  ]

  const aiTag = () => {
    const ids = app().selection
    useSelectionDialog.getState().showFor('tag', ids.length ? [...ids] : null, ids.length)
  }

  // The bar in the user's order; a hidden place is not drawn (it waits in More).
  const bar: Record<string, ReactNode> = {
    ...Object.fromEntries(
      places.map((p) => [
        p.id,
        <button
          key={p.id}
          type="button"
          className={styles.place}
          aria-current={p.current ? 'page' : undefined}
          onClick={p.go}
          title={p.classic ? `${t(p.label)} · ${t('next.place.classicHint')}` : undefined}
          data-testid={`next-place-${p.id}`}
        >
          {t(p.label)}
        </button>,
      ]),
    ),
    censor: <Menu key="censor" label={t('next.place.censor')} items={censorItems} testId="next-censor" />,
    similar: <Menu key="similar" label={t('next.place.similar')} items={similarItems} testId="next-similar" />,
  }
  const labels = Object.fromEntries(NEXT_PLACES.map((p) => [p.id, t(p.label)]))

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
        <button
          ref={brandRef}
          type="button"
          className={styles.brand}
          onClick={() => app().setPage('home')}
          title={t('nav.home')}
          aria-label={tight ? `${t('next.brand')} · ${t('nav.home')}` : undefined}
        >
          {tight ? <FrameMark className={styles.mark} /> : <span className={styles.name}>{t('next.brand')}</span>}
          {stats.data?.app_version && <span className={styles.version}>{stats.data.app_version}</span>}
          <span className={styles.trial}>{t('next.trial')}</span>
        </button>

        <nav className={styles.places} aria-label="main">
          {shownIds(choice).map((id) => bar[id])}
          <Menu label={t('next.place.more')} items={more} current={hiddenCurrent || (page === 'tools' && !BAR_TOOLS.has(toolId))} testId="next-more" />
        </nav>

        <span ref={gapRef} className={styles.gap} />

        <AiBusyChip />
        <UpdateHint />
        <JobsMenu />
        <button ref={findRef} type="button" className={`btn btn-ghost ${styles.find}`} onClick={() => app().setPaletteOpen(true)} data-testid="open-palette">
          <Icon name="search" size={14} />
          <span>{t('next.find')}</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button type="button" className="btn" onClick={aiTag} title={t('next.aiTagTitle')} data-testid="next-ai-tag">
          {t('next.aiTag')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => useSelectionDialog.getState().showFor('import', null, 1)}
          data-testid="import-button"
        >
          <Icon name="folder" size={15} />
          {t('import.button')}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => app().openSettings()}
          aria-current={page === 'settings' ? 'page' : undefined}
          title={t('settings.gear')}
          aria-label={t('settings.title')}
          data-testid="settings-button"
        >
          <Icon name="gear" />
          <span className={styles.settingsLabel}>{t('settings.title')}</span>
        </button>
      </header>
      {customizeOpen && <NavCustomizeDialog useStore={useNextNav} defs={NEXT_PLACES} labels={labels} onClose={() => setCustomizeOpen(false)} />}
    </>
  )
}
