import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useLibraries } from '../api/queries'
import { useT } from '../i18n'
import { generatorName } from '../lib/format'
import { tailOfPath } from '../lib/paths'
import { parseSearch } from '../lib/searchQuery'
import { useApp } from '../state/store'
import { Icon } from '../ui/Icon'
import { useClickOutside, useLayer } from '../ui/layers'
import { QueryBar } from '../features/library/QueryBar'
import { displayName, ScopeLists } from '../features/library/Rail'
import { useSelectionDialog } from '../features/selection/dialogs'
import styles from './ScopeLine.module.css'

interface Props {
  total: number | null
  about: boolean
  inputRef: RefObject<HTMLInputElement | null>
}

/**
 * "What am I looking at", on one line (docs/DESIGN.md §redesign-2026-10):
 * library ▾ › scope ▾, the search with its conditions, filter, sort, view,
 * the count, and one button that clears every condition.
 */
export function ScopeLine({ total, about, inputRef }: Props) {
  const t = useT()
  const queryText = useApp((s) => s.queryText)
  const scope = useApp((s) => s.scope)
  const conditions = useMemo(() => {
    const scoped = (scope.favorites ? 1 : 0) + (scope.folder ? 1 : 0) + scope.generators.length
    return parseSearch(queryText).parts.length + scoped
  }, [queryText, scope])

  const clearAll = () => {
    const s = useApp.getState()
    s.setQueryText('')
    s.setScope({ favorites: false, folder: null, generators: [] })
  }

  return (
    <div className={styles.line} data-testid="next-scope-line">
      <div className={styles.crumbs}>
        <LibraryCrumb />
        <span className={styles.gt} aria-hidden>
          ›
        </span>
        <ScopeCrumb />
      </div>
      <div className={styles.query}>
        <QueryBar total={total} about={about} inputRef={inputRef} railToggle={false} />
      </div>
      {conditions > 0 && (
        <button type="button" className={`btn btn-ghost ${styles.clear}`} onClick={clearAll} title={t('next.scope.clearTitle')} data-testid="next-clear-conditions">
          {t('next.scope.clear', { n: conditions })}
        </button>
      )}
    </div>
  )
}

/** A crumb that opens its own panel; Esc or a click outside closes it. */
function Crumb({ label, big, children, testId }: { label: string; big?: boolean; children: (close: () => void) => ReactNode; testId: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = () => setOpen(false)
  useLayer(open, close)
  useClickOutside(ref, open, close)
  return (
    <div className={styles.crumbWrap} ref={ref}>
      <button
        type="button"
        className={styles.crumb}
        data-big={big || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid={testId}
      >
        <span className={styles.crumbText}>{label}</span>
        <Icon name="caret" size={12} />
      </button>
      {open && (
        <div className={styles.panel} role="dialog" aria-label={label}>
          {children(close)}
        </div>
      )}
    </div>
  )
}

function LibraryCrumb() {
  const t = useT()
  const libraries = useLibraries()
  const libraryId = useApp((s) => s.libraryId)
  const setLibrary = useApp((s) => s.setLibrary)
  const list = libraries.data?.libraries ?? []
  const current = list.find((l) => l.id === libraryId)
  return (
    <Crumb label={displayName(current?.name, current?.is_default, t)} big testId="next-library-crumb">
      {(close) => (
        <ul className={styles.menu} role="menu">
          {list.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={l.id === libraryId}
                className={styles.menuRow}
                onClick={() => {
                  setLibrary(l.id)
                  close()
                }}
              >
                <span>{displayName(l.name, l.is_default, t)}</span>
                <span className={styles.count}>{l.image_count.toLocaleString()}</span>
              </button>
            </li>
          ))}
          <li className={styles.divider}>
            <button
              type="button"
              role="menuitem"
              className={styles.menuRow}
              onClick={() => {
                close()
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
              className={styles.menuRow}
              onClick={() => {
                close()
                useSelectionDialog.getState().showFor('libraries', null, 1)
              }}
            >
              {t('libraries.manageMenu')}
            </button>
          </li>
        </ul>
      )}
    </Crumb>
  )
}

/** All images, favourites, saved searches, sources and folders: the rail's lists, one click away. */
function ScopeCrumb() {
  const t = useT()
  const scope = useApp((s) => s.scope)
  const parts: string[] = []
  if (scope.favorites) parts.push(t('next.scope.favorites'))
  if (scope.folder) parts.push(t('next.scope.folder', { name: tailOfPath(scope.folder, 28) }))
  if (scope.generators.length === 1) parts.push(generatorName(scope.generators[0] ?? null, t))
  else if (scope.generators.length > 1) parts.push(t('next.scope.sources', { n: scope.generators.length }))
  const label = parts.length ? parts.join(' + ') : t('rail.all')
  return (
    <Crumb label={label} testId="next-scope-crumb">
      {() => (
        <div className={styles.scopePanel}>
          <ScopeLists />
        </div>
      )}
    </Crumb>
  )
}
