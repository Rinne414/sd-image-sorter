import { useMemo } from 'react'
import { useImageCount } from '../../../api/queries'
import { useApp } from '../../../state/store'
import { currentLibraryParams } from '../../library/params'
import styles from './Lexicon.module.css'
import { useLT } from './lexiconText'

// The right column: the library search a click in the list edits, how many
// images it finds, and the way to them.

function viewInLibrary(): void {
  const s = useApp.getState()
  if (s.lightboxId !== null) s.closeLightbox()
  s.setPage('library')
}

export function QueryPanel({ tagsTab }: { tagsTab: boolean }) {
  const lt = useLT()
  const libraryId = useApp((s) => s.libraryId)
  const queryText = useApp((s) => s.queryText)
  const scope = useApp((s) => s.scope)
  const params = useMemo(currentLibraryParams, [libraryId, queryText, scope])
  const count = useImageCount(params).data
  const scoped = scope.generators.length > 0 || scope.folder !== null || scope.favorites
  const text = queryText.trim()

  return (
    <aside className={styles.side} data-testid="lex-query">
      <p className={styles.what}>{lt('lex.what')}</p>
      <h3 className={styles.sideTitle}>{lt('lex.query.title')}</h3>
      {text ? (
        <p className={`${styles.queryText} mono`} data-testid="lex-query-text">
          {text}
        </p>
      ) : (
        <p className={styles.hint} data-testid="lex-query-text">
          {lt('lex.query.empty')}
        </p>
      )}
      <p className={styles.countLine} data-testid="lex-query-count">
        {count === undefined ? lt('lex.query.counting') : lt('lex.query.count', { n: count })}
        {scoped && ` · ${lt('lex.query.scoped')}`}
      </p>
      <div className={styles.buttons}>
        <button type="button" className="btn btn-primary" onClick={viewInLibrary} data-testid="lex-view">
          {lt('lex.query.view')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => useApp.getState().setQueryText('')} disabled={!text} data-testid="lex-clear">
          {lt('lex.query.clear')}
        </button>
      </div>
      <p className={styles.hint}>{lt('lex.query.hint')}</p>
      {tagsTab && <p className={styles.hint}>{lt('lex.recat.hint')}</p>}
    </aside>
  )
}
