import { useRef, useState } from 'react'
import { useImageCount } from '../../api/queries'
import { parseSearch, toImageParams } from '../../lib/searchQuery'
import { useSavedSearches, type SavedSearch } from '../../state/savedSearches'
import { useToasts } from '../../ui/toasts'
import { useFavorites, useFolders, useGenerators, useLibraries, useLibraryHealth, useMissingCount } from '../../api/queries'
import { useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { useSelectionDialog } from '../selection/dialogs'
import { startColorAnalysis, useColorsMissing } from '../status/colorAnalysis'
import { useT, type MessageKey } from '../../i18n'
import { generatorName, shortFolder } from '../../lib/format'
import { useApp } from '../../state/store'
import styles from './Rail.module.css'
import { Icon } from '../../ui/Icon'
import { useClickOutside, useLayer } from '../../ui/layers'

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

        <h3 className={styles.heading}>{t('rail.sources')}</h3>
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

        {folders.data && folders.data.length > 0 && (
          <>
            <h3 className={styles.heading}>{t('rail.folders')}</h3>
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
          </>
        )}
      </div>

      <Status />
    </nav>
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
        className={styles.libraryButton}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t('rail.switchLibrary')}
        onClick={() => setOpen(!open)}
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

interface StatusRow {
  key: MessageKey
  n: number
  /** Quiet rows are chores, not problems (colour analysis). */
  quiet?: boolean
  action?: { label: string; run: () => void; busy?: boolean }
}

/** Only speaks up when something needs attention, and offers the fix next to it. */
function Status() {
  const t = useT()
  const health = useLibraryHealth()
  const missing = useMissingCount()
  const colors = useColorsMissing()
  const showFor = useSelectionDialog((s) => s.showFor)
  const analysing = useJobs((s) => s.jobs.some((j) => j.kind === 'colors' && !isFinished(j.progress.status)))
  if (!health.data) return null
  const c = health.data.issue_counts
  const untagged = c.untagged ?? 0
  const rows: StatusRow[] = [
    { key: 'rail.untagged', n: untagged, action: { label: t('sel.tag'), run: () => showFor('tag', null, untagged) } },
    { key: 'rail.unreadable', n: c.unreadable ?? 0 },
    { key: 'rail.missing', n: missing.data ?? 0 },
    { key: 'rail.metaError', n: c.metadata_error ?? 0 },
    {
      key: 'status.colorsMissing',
      n: colors.data?.missing ?? 0,
      quiet: true,
      action: { label: analysing ? t('status.analysing') : t('status.analyse'), run: () => void startColorAnalysis(), busy: analysing },
    },
  ]
  const shown = rows.filter((r) => r.n > 0)
  return (
    <section className={styles.status} aria-label={t('rail.status')} data-testid="library-status">
      <h3 className={styles.heading}>{t('rail.status')}</h3>
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
    </section>
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
    <>
      <h3 className={styles.heading}>{t('rail.saved')}</h3>
      <ul className={styles.list} data-testid="smart-filters">
        {list.map((s, i) => (
          <SmartFilterRow key={s.id} saved={s} index={i} active={queryText.trim() === s.query} />
        ))}
      </ul>
    </>
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
