import { useT, type MessageKey } from '../i18n'
import { useApp } from '../state/store'
import { Icon } from '../ui/Icon'
import { Menu, type MenuItem } from '../ui/Menu'
import { useToasts } from '../ui/toasts'
import { AiBusyChip } from '../features/jobs/AiBusyChip'
import { JobsMenu } from '../features/jobs/JobsMenu'
import { useSelectionDialog } from '../features/selection/dialogs'
import { useAppStats } from '../features/settings/about/aboutApi'
import { UpdateHint } from '../features/settings/about/UpdateHint'
import { useSimilarDialogs } from '../features/similar/dialogs'
import { TOOLS } from '../features/tools/registry'
import { findLoadedImage } from '../api/loaded'
import { quickCensor } from '../features/censor/quickCensor'
import { pickImageFile } from '../features/similar/imageSearch'
import { showLikeImage, useSimilar } from '../features/similar/similarStore'
import { openClassic, type ClassicView } from './classicLink'
import styles from './NextTopBar.module.css'

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
  const classic = (id: string, label: MessageKey, view: ClassicView): Place => ({
    id,
    label,
    current: false,
    go: () => openClassic(view),
    classic: true,
  })

  const places: Place[] = [
    { id: 'library', label: 'next.place.library', current: page === 'library', go: () => app().setPage('library') },
    { id: 'batch', label: 'next.place.batch', current: page === 'batch', go: () => app().setPage('batch') },
    { id: 'sort', label: 'next.place.sort', current: page === 'sort', go: () => app().setPage('sort') },
    { id: 'reader', label: 'next.place.reader', current: page === 'tools' && toolId === 'reader', go: () => app().openTool('reader') },
    classic('stylemap', 'next.place.stylemap', 'stylemap'),
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

  const more: MenuItem[] = [
    ...TOOLS.filter((tool) => tool.id !== 'reader').map((tool) => ({
      id: `tool-${tool.id}`,
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
    { id: 'dataset', label: t('next.more.dataset'), hint: t('next.place.classicHint'), divider: true, onSelect: () => openClassic('dataset') },
    { id: 'classic', label: t('next.more.classicUi'), divider: true, onSelect: () => openClassic() },
    { id: 'vopus', label: t('next.more.vopusUi'), onSelect: () => location.assign('/vopus/') },
  ]

  const aiTag = () => {
    const ids = app().selection
    useSelectionDialog.getState().showFor('tag', ids.length ? [...ids] : null, ids.length)
  }

  return (
    <header className={styles.bar}>
      <button type="button" className={styles.brand} onClick={() => app().setPage('home')} title={t('nav.home')}>
        <span className={styles.name}>{t('next.brand')}</span>
        {stats.data?.app_version && <span className={styles.version}>{stats.data.app_version}</span>}
        <span className={styles.trial}>{t('next.trial')}</span>
      </button>

      <nav className={styles.places} aria-label="main">
        {places.map((p) => (
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
          </button>
        ))}
        <Menu label={t('next.place.censor')} items={censorItems} testId="next-censor" />
        <Menu label={t('next.place.similar')} items={similarItems} testId="next-similar" />
        <Menu label={t('next.place.more')} items={more} current={page === 'tools' && toolId !== 'reader'} testId="next-more" />
      </nav>

      <span className={styles.gap} />

      <AiBusyChip />
      <UpdateHint />
      <JobsMenu />
      <button type="button" className={`btn btn-ghost ${styles.find}`} onClick={() => app().setPaletteOpen(true)} data-testid="open-palette">
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
  )
}
