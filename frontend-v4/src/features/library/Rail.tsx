import { useRef, useState } from 'react'
import { useImageCount } from '../../api/queries'
import { parseSearch, toImageParams } from '../../lib/searchQuery'
import { useSavedSearches, type SavedSearch } from '../../state/savedSearches'
import { useToasts } from '../../ui/toasts'
import { useFavorites, useFolders, useGenerators, useLibraries } from '../../api/queries'
import { useSelectionDialog } from '../selection/dialogs'
import { useStatusDialogs } from '../status/dialogs'
import { useStatusRows, type StatusRow } from '../status/statusRows'
import { useT } from '../../i18n'
import { generatorName, shortFolder } from '../../lib/format'
import { useApp } from '../../state/store'
import styles from './Rail.module.css'
import { Icon } from '../../ui/Icon'
import { useClickOutside, useLayer } from '../../ui/layers'
import { useRailSections, type RailSectionId } from './railSections'

interface Props {
  /** Prompt text woven faintly behind the library name. */
  texture: string
}

export function Rail({ texture }: Props) {
  const t = useT()
  const libraries = useLibraries()
  const generators = useGenerators()
  const folders = useFolders()
  const favorites = useFavorites()
  const libraryId = useApp((s) => s.libraryId)
  const scope = useApp((s) => s.scope)
  const setScope = useApp((s) => s.setScope)
  const current = libraries.data?.libraries.find((l) => l.id === libraryId)
  const isAll = !scope.favorites && !scope.folder && scope.generators.length === 0

  const toggleGen = (g: string) =>
    setScope({ generators: scope.generators.includes(g) ? scope.generators.filter((x) => x !== g) : [...scope.generators, g] })

  return (
    <nav className={styles.rail} aria-label={t('nav.library')}>
      <LibraryLabel name={displayName(current?.name, current?.is_default, t)} count={current?.image_count ?? null} texture={texture} />

      <div className={styles.scroll}>
        <ul className={styles.list}>
          <Row
            active={isAll}
            label={t('rail.all')}
            count={current?.image_count}
            onClick={() => setScope({ favorites: false, folder: null, generators: [] })}
          />
          <Row
            active={scope.favorites}
            label={t('rail.favorites')}
            icon={<Icon name="heart" filled size={13} />}
            iconClass={styles.fav}
            count={favorites.data?.ids.size}
            onClick={() => setScope({ favorites: !scope.favorites })}
          />
        </ul>

        <SmartFilters />

        <Section id="sources" title={t('rail.sources')}>
          <ul className={styles.list}>
            {(generators.data ?? []).map((g) => (
              <Row
                key={g.generator}
                active={scope.generators.includes(g.generator)}
                label={generatorName(g.generator, t)}
                count={g.count}
                dim={g.generator === 'unknown' || g.generator === 'others'}
                onClick={() => toggleGen(g.generator)}
              />
            ))}
          </ul>
        </Section>

        {folders.data && folders.data.length > 0 && (
          <Section id="folders" title={t('rail.folders')}>
            <ul className={styles.list}>
              {folders.data.map((f) => (
                <Row
                  key={f}
                  active={scope.folder === f}
                  label={shortFolder(f)}
                  title={f}
                  onClick={() => setScope({ folder: scope.folder === f ? null : f })}
                />
              ))}
            </ul>
          </Section>
        )}
      </div>

      <Status />
    </nav>
  )
}

/** A rail heading that folds its list away; remembered across reloads. */
function Section({ id, title, children }: { id: RailSectionId; title: string; children: React.ReactNode }) {
  const folded = useRailSections((s) => !!s.folded[id])
  const toggle = useRailSections((s) => s.toggle)
  return (
    <section data-rail-section={id}>
      <h3 className={styles.heading}>
        <button type="button" className={styles.fold} aria-expanded={!folded} onClick={() => toggle(id)}>
          <span className={styles.foldCaret} aria-hidden>
            <Icon name="caret" size={11} />
          </span>
          {title}
        </button>
      </h3>
      {!folded && children}
    </section>
  )
}

function displayName(name: string | undefined, isDefault: boolean | undefined, t: ReturnType<typeof useT>): string {
  if (!name) return '…'
  // The seeded default library is named in English in the database.
  if (isDefault && name === 'Main library') return t('rail.mainLibrary')
  return name
}

function LibraryLabel({ name, count, texture }: { name: string; count: number | null; texture: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const libraries = useLibraries()
  const setLibrary = useApp((s) => s.setLibrary)
  const libraryId = useApp((s) => s.libraryId)
  const ref = useRef<HTMLDivElement>(null)

  useLayer(open, () => setOpen(false))
  useClickOutside(ref, open, () => setOpen(false))

  return (
    <div className={styles.label} ref={ref}>
      <div className={styles.texture} aria-hidden>
        {texture}
      </div>
      <button
        type="button"
        className={`btn btn-ghost btn-icon ${styles.collapse}`}
        onClick={() => useApp.getState().toggleRail()}
        aria-label={t('rail.collapse')}
        title={t('rail.collapse')}
        data-testid="rail-collapse"
      >
        <Icon name="left" size={14} />
      </button>
      <button
        type="button"
        className={styles.libraryButton}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t('rail.switchLibrary')}
        onClick={() => setOpen(!open)}
        data-testid="library-switch"
      >
        <span className={styles.libraryName}>{name}</span>
        <span className={styles.caret} aria-hidden>
          <Icon name="caret" size={14} />
        </span>
      </button>
      {count !== null && <span className={`${styles.libraryCount} mono`}>{t('rail.images', { n: count })}</span>}
      {open && (
        <ul className={styles.menu} role="menu">
          {(libraries.data?.libraries ?? []).map((l) => (
            <li key={l.id}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={l.id === libraryId}
                onClick={() => {
                  setLibrary(l.id)
                  setOpen(false)
                }}
              >
                <span>{displayName(l.name, l.is_default, t)}</span>
                <span className="mono">{l.image_count.toLocaleString()}</span>
              </button>
            </li>
          ))}
          <li className={styles.menuDivider}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                useSelectionDialog.getState().showFor('new-library', null, 1)
              }}
            >
              {t('libraries.newMenu')}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                useSelectionDialog.getState().showFor('libraries', null, 1)
              }}
            >
              {t('libraries.manageMenu')}
            </button>
          </li>
        </ul>
      )}
    </div>
  )
}

interface RowProps {
  label: string
  count?: number | undefined
  active: boolean
  onClick: () => void
  icon?: React.ReactNode
  iconClass?: string
  dim?: boolean
  title?: string
}

function Row({ label, count, active, onClick, icon, iconClass, dim, title }: RowProps) {
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        aria-pressed={active}
        data-dim={dim || undefined}
        onClick={onClick}
        title={title ?? label}
      >
        {icon && <span className={iconClass}>{icon}</span>}
        <span className={styles.rowLabel}>{label}</span>
        {count !== undefined && <span className={`${styles.count} mono`}>{count.toLocaleString()}</span>}
      </button>
    </li>
  )
}

/** Only speaks up when something needs attention, and offers the fix next to it. */
function Status() {
  const t = useT()
  const rows = useStatusRows()
  if (!rows) return null
  const shown = rows.filter((r) => r.n > 0)
  return (
    <section className={styles.status} aria-label={t('rail.status')} data-testid="library-status">
      <StatusBody shown={shown} />
    </section>
  )
}

function StatusBody({ shown }: { shown: StatusRow[] }) {
  const t = useT()
  const openReport = (
    <button type="button" className={`${styles.fix} ${styles.report}`} onClick={() => useStatusDialogs.getState().setReport(true)} data-testid="status-report-open">
      {t('status.report.open')}
    </button>
  )
  return (
    <Section id="status" title={t('rail.status')}>
      {shown.length === 0 ? (
        <p className={styles.clean}>{t('rail.statusClean')}</p>
      ) : (
        <ul className={styles.issues}>
          {shown.map((r) => (
            <li key={r.key} data-quiet={r.quiet || undefined}>
              <span>{t(r.key, { n: r.n })}</span>
              {r.action && (
                <button type="button" className={styles.fix} onClick={r.action.run} disabled={r.action.busy}>
                  {r.action.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {openReport}
    </Section>
  )
}

/** Saved query lines for this library, each with a live count. */
function SmartFilters() {
  const t = useT()
  const libraryId = useApp((s) => s.libraryId)
  const list = useSavedSearches((s) => s.byLibrary[libraryId]) ?? []
  const queryText = useApp((s) => s.queryText)
  if (!list.length) return null
  return (
    <Section id="saved" title={t('rail.saved')}>
      <ul className={styles.list} data-testid="smart-filters">
        {list.map((s, i) => (
          <SmartFilterRow key={s.id} saved={s} index={i} active={queryText.trim() === s.query} />
        ))}
      </ul>
    </Section>
  )
}

function SmartFilterRow({ saved, index, active }: { saved: SavedSearch; index: number; active: boolean }) {
  const t = useT()
  const libraryId = useApp((s) => s.libraryId)
  const setQueryText = useApp((s) => s.setQueryText)
  const setScope = useApp((s) => s.setScope)
  const remove = useSavedSearches((s) => s.remove)
  const restore = useSavedSearches((s) => s.restore)
  const count = useImageCount(toImageParams(parseSearch(saved.query), { generators: [], folder: null, favoritesCollectionId: null }, 'newest'))
  return (
    <li className={styles.savedRow}>
      <button
        type="button"
        className={styles.row}
        aria-pressed={active}
        title={saved.query}
        onClick={() => {
          setScope({ favorites: false, folder: null, generators: [] })
          setQueryText(saved.query)
        }}
      >
        <span className={styles.rowLabel}>{saved.name}</span>
        {count.data !== undefined && <span className={`${styles.count} mono`}>{count.data.toLocaleString()}</span>}
      </button>
      <button
        type="button"
        className={styles.remove}
        aria-label={t('rail.savedRemove', { name: saved.name })}
        title={t('rail.savedRemove', { name: saved.name })}
        onClick={() => {
          const gone = remove(libraryId, saved.id)
          if (gone) {
            useToasts.getState().push(t('rail.savedRemoved', { name: gone.name }), 'info', {
              label: t('toast.undo'),
              run: () => restore(libraryId, gone, index),
            })
          }
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </li>
  )
}
