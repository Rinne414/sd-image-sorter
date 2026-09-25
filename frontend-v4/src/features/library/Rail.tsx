import { useEffect, useRef, useState } from 'react'
import { useFavorites, useFolders, useGenerators, useLibraries, useLibraryHealth, useMissingCount } from '../../api/queries'
import { useT, type MessageKey } from '../../i18n'
import { generatorName, shortFolder } from '../../lib/format'
import { useApp } from '../../state/store'
import styles from './Rail.module.css'
import { Icon } from '../../ui/Icon'

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

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', esc, true)
    }
  }, [open])

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

/** Only speaks up when something needs attention. */
function Status() {
  const t = useT()
  const health = useLibraryHealth()
  const missing = useMissingCount()
  if (!health.data) return null
  const c = health.data.issue_counts
  const issues: [MessageKey, number][] = (
    [
      ['rail.untagged', c.untagged ?? 0],
      ['rail.unreadable', c.unreadable ?? 0],
      ['rail.missing', missing.data ?? 0],
      ['rail.metaError', c.metadata_error ?? 0],
    ] as [MessageKey, number][]
  ).filter(([, n]) => n > 0)
  return (
    <section className={styles.status} aria-label={t('rail.status')}>
      <h3 className={styles.heading}>{t('rail.status')}</h3>
      {issues.length === 0 ? (
        <p className={styles.clean}>{t('rail.statusClean')}</p>
      ) : (
        <ul className={styles.issues}>
          {issues.map(([key, n]) => (
            <li key={key}>{t(key, { n })}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
