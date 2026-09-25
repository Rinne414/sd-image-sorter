import { useState } from 'react'
import { useLibraries } from '../../api/queries'
import type { Library } from '../../api/types'
import { useT, type MessageKey, type Params } from '../../i18n'
import { useApp } from '../../state/store'
import { Dialog } from '../../ui/Dialog'
import { createLibrary, deleteLibrary, exportUrl, moveToLibrary, renameLibrary } from './libraries'
import styles from './LibrariesDialog.module.css'

const NAME_MAX = 80

type T = (key: MessageKey, params?: Params) => string

function displayName(lib: Library, t: T): string {
  // The seeded default library is named in English in the database.
  return lib.is_default && lib.name === 'Main library' ? t('rail.mainLibrary') : lib.name
}

/** Every library: switch, rename, export the index, delete (never the main one), and make a new one. */
export function LibrariesDialog({ creating, onClose }: { creating: boolean; onClose: () => void }) {
  const t = useT()
  const libraries = useLibraries()
  const current = useApp((s) => s.libraryId)
  const setLibrary = useApp((s) => s.setLibrary)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    const lib = await createLibrary(name)
    setBusy(false)
    if (!lib) return
    setNewName('')
    setLibrary(lib.id)
  }

  const footer = (
    <button type="button" className="btn btn-ghost" onClick={onClose}>
      {t('common.close')}
    </button>
  )

  return (
    <Dialog title={t('libraries.title')} onClose={onClose} footer={footer} testId="libraries-dialog" wide>
      <p className={styles.lead}>{t('libraries.lead')}</p>
      <ul className={styles.list}>
        {(libraries.data?.libraries ?? []).map((lib) => (
          <LibraryRow key={lib.id} lib={lib} current={lib.id === current} onSwitch={() => setLibrary(lib.id)} />
        ))}
      </ul>
      <div className={styles.create}>
        <input
          autoFocus={creating}
          value={newName}
          maxLength={NAME_MAX}
          placeholder={t('libraries.newName')}
          aria-label={t('libraries.newName')}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void create()
            }
          }}
        />
        <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={!newName.trim() || busy}>
          {t('libraries.create')}
        </button>
      </div>
    </Dialog>
  )
}

function LibraryRow({ lib, current, onSwitch }: { lib: Library; current: boolean; onSwitch: () => void }) {
  const t = useT()
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view')
  const [name, setName] = useState(lib.name)
  const shown = displayName(lib, t)

  const rename = async () => {
    if (!name.trim() || name.trim() === lib.name) return setMode('view')
    if (await renameLibrary(lib.id, name)) setMode('view')
  }

  return (
    <li className={styles.row} data-current={current || undefined} data-testid="library-row">
      {mode === 'rename' ? (
        <input
          className={styles.renameInput}
          autoFocus
          value={name}
          maxLength={NAME_MAX}
          aria-label={t('libraries.rename')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void rename()
            }
          }}
          onBlur={() => void rename()}
        />
      ) : (
        <span className={styles.name}>
          {shown}
          {current && <span className={styles.here}>{t('libraries.current')}</span>}
        </span>
      )}
      <span className={`${styles.count} mono`}>{t('rail.images', { n: lib.image_count })}</span>
      {mode === 'delete' ? (
        <span className={styles.confirm}>
          <span>{t('libraries.confirmDelete', { name: shown, n: lib.image_count })}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setMode('view')}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void deleteLibrary(lib.id)}>
            {t('libraries.deleteOk')}
          </button>
        </span>
      ) : (
        <span className={styles.actions}>
          {!current && (
            <button type="button" className={styles.fix} onClick={onSwitch}>
              {t('libraries.switch')}
            </button>
          )}
          <button type="button" className={styles.fix} onClick={() => setMode('rename')}>
            {t('libraries.rename')}
          </button>
          <a className={styles.fix} href={exportUrl(lib.id)} download>
            {t('libraries.export')}
          </a>
          {!lib.is_default && (
            <button type="button" className={`${styles.fix} ${styles.danger}`} onClick={() => setMode('delete')}>
              {t('libraries.delete')}
            </button>
          )}
        </span>
      )}
    </li>
  )
}

/** Send the picks to another library (they leave this one). */
export function MoveToLibraryDialog({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const t = useT()
  const libraries = useLibraries()
  const current = useApp((s) => s.libraryId)
  const others = (libraries.data?.libraries ?? []).filter((l) => l.id !== current)
  const [target, setTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const chosen = target ?? others[0]?.id ?? null

  const go = async () => {
    if (!chosen) return
    setBusy(true)
    const moved = await moveToLibrary(ids, chosen)
    setBusy(false)
    if (moved !== null) onClose()
  }

  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void go()} disabled={!chosen || busy}>
        {t('libraries.moveOk', { n: ids.length })}
      </button>
    </>
  )

  return (
    <Dialog title={t('libraries.moveTitle', { n: ids.length })} onClose={onClose} footer={footer} testId="move-library-dialog">
      {others.length === 0 ? (
        <p className={styles.lead}>{t('libraries.noOther')}</p>
      ) : (
        <div className={styles.choices} role="radiogroup" aria-label={t('libraries.moveTitle', { n: ids.length })}>
          {others.map((lib) => (
            <label key={lib.id} className={styles.choice}>
              <input type="radio" name="target-library" checked={chosen === lib.id} onChange={() => setTarget(lib.id)} />
              <span>{displayName(lib, t)}</span>
              <span className={`${styles.count} mono`}>{t('rail.images', { n: lib.image_count })}</span>
            </label>
          ))}
        </div>
      )}
      <p className={styles.note}>{t('libraries.moveNote')}</p>
    </Dialog>
  )
}
