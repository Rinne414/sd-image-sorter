import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, unwrap } from '../../api/client'
import { findLoadedImage } from '../../api/loaded'
import { useT, type MessageKey } from '../../i18n'
import { folderNameProblem, joinFolder, parentFolder, tailOfPath, type FolderNameProblem } from '../../lib/paths'
import { Dialog } from '../../ui/Dialog'
import { Icon } from '../../ui/Icon'
import { useLayer } from '../../ui/layers'
import { startFileJob } from '../jobs/fileJobs'
import { recentDestinations, rememberDestination } from './dialogs'
import styles from './FolderPicker.module.css'

interface Listing {
  /** '' is "this computer" (the drive list on Windows). */
  current: string
  parent: string | null
  subdirs: { name: string; path: string; has_children: boolean }[]
}

/** Mono characters that fit the 180px places column. */
const PLACE_CHARS = 21

const NAME_PROBLEM: Record<FolderNameProblem, MessageKey> = {
  empty: 'picker.name.empty',
  chars: 'picker.name.chars',
  dots: 'picker.name.dots',
  trailing: 'picker.name.trailing',
  reserved: 'picker.name.reserved',
}

interface Props {
  operation: 'move' | 'copy'
  ids: number[]
  onClose: () => void
}

/** Choose where picked images go by browsing folders; typing a path also works. */
export function FolderPicker({ operation, ids, onClose }: Props) {
  const t = useT()
  const [listing, setListing] = useState<Listing | null>(null)
  const [typed, setTyped] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [newName, setNewName] = useState('')
  const [nameProblem, setNameProblem] = useState<FolderNameProblem | null>(null)
  const [child, setChild] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const pathRef = useRef<HTMLInputElement>(null)
  const request = useRef(0)

  const recent = useMemo(recentDestinations, [])
  const source = useMemo(() => {
    const first = ids[0]
    const img = first === undefined ? null : findLoadedImage(first)
    return img ? parentFolder(img.path) : null
  }, [ids])

  const browse = useCallback(async (path: string): Promise<boolean> => {
    const req = ++request.current
    setLoading(true)
    setError(null)
    try {
      const res = unwrap<Listing>(await api.POST('/api/browse-folder', { body: { path } }))
      if (req !== request.current) return true
      setListing(res)
      setTyped(res.current)
      setChild(null)
      setNaming(false)
      return true
    } catch (e) {
      if (req === request.current) setError((e as Error).message)
      return false
    } finally {
      if (req === request.current) setLoading(false)
    }
  }, [])

  // Start where the first pick lives, else the last destination, else the drive list.
  useEffect(() => {
    const start = source ?? recent[0] ?? ''
    void browse(start).then((ok) => {
      if (!ok && start) void browse('')
    })
  }, [browse, source, recent])

  useLayer(naming, () => {
    setNaming(false)
    setNameProblem(null)
  })

  const current = listing?.current ?? ''
  const target = current ? (child ? joinFolder(current, child) : current) : null

  const addChild = () => {
    const problem = folderNameProblem(newName)
    setNameProblem(problem)
    if (problem) return
    const name = newName.trim()
    const existing = listing?.subdirs.find((d) => d.name.toLowerCase() === name.toLowerCase())
    setNewName('')
    setNaming(false)
    if (existing) void browse(existing.path)
    else setChild(name)
  }

  const confirm = async () => {
    if (!target || starting) return
    setStarting(true)
    const ok = await startFileJob(operation, ids, target)
    setStarting(false)
    if (!ok) return
    rememberDestination(target)
    onClose()
  }

  const up = () => {
    if (listing && listing.parent !== null) void browse(listing.parent)
  }

  const title = t(operation === 'move' ? 'picker.titleMove' : 'picker.titleCopy', { n: ids.length })
  const confirmLabel = t(operation === 'move' ? 'picker.confirmMove' : 'picker.confirmCopy', { n: ids.length })

  const footer = (
    <>
      <span className={styles.footStart}>
        {naming ? (
          <span className={styles.naming}>
            <input
              className={styles.nameInput}
              data-testid="folder-new-name"
              autoFocus
              value={newName}
              placeholder={t('picker.newName')}
              aria-label={t('picker.newName')}
              title={t('picker.newHint')}
              onChange={(e) => {
                setNewName(e.target.value)
                setNameProblem(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addChild()
                }
              }}
            />
            {nameProblem && (
              <span className={styles.nameProblem} role="alert">
                {t(NAME_PROBLEM[nameProblem])}
              </span>
            )}
          </span>
        ) : (
          <button type="button" className="btn" onClick={() => setNaming(true)} disabled={!current}>
            {t('picker.newFolder')}
          </button>
        )}
      </span>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={!target || starting}>
        {confirmLabel}
      </button>
    </>
  )

  return (
    <Dialog title={title} onClose={onClose} footer={footer} testId="folder-picker" initialFocus={pathRef} wide>
      <div className={styles.pathRow}>
        <button
          type="button"
          className="btn btn-icon"
          onClick={up}
          disabled={!listing || listing.parent === null}
          aria-label={t('picker.up')}
          title={t('picker.up')}
        >
          <Icon name="up" size={15} />
        </button>
        <input
          ref={pathRef}
          className={`${styles.path} mono`}
          data-testid="folder-path"
          value={typed}
          spellCheck={false}
          placeholder={t('picker.computer')}
          aria-label={t('picker.path')}
          title={t('picker.pathHint')}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void browse(typed.trim())
            }
          }}
        />
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {t('picker.error', { reason: error })}
        </p>
      )}
      <div className={styles.columns}>
        <nav className={styles.places} aria-label={t('picker.recent')}>
          {source && (
            <div className={styles.group}>
              <h3 className={styles.groupTitle}>{t('picker.source')}</h3>
              <button type="button" className={styles.place} onClick={() => void browse(source)} title={source}>
                {tailOfPath(source, PLACE_CHARS)}
              </button>
            </div>
          )}
          {recent.length > 0 && (
            <div className={styles.group} data-testid="folder-recent">
              <h3 className={styles.groupTitle}>{t('picker.recent')}</h3>
              {recent.map((p) => (
                <button key={p} type="button" className={styles.place} onClick={() => void browse(p)} title={p}>
                  {tailOfPath(p, PLACE_CHARS)}
                </button>
              ))}
            </div>
          )}
          <div className={styles.group}>
            <button type="button" className={styles.place} onClick={() => void browse('')}>
              {t('picker.computer')}
            </button>
          </div>
        </nav>
        <ul
          className={styles.folders}
          data-testid="folder-list"
          aria-busy={loading || undefined}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault()
              up()
            }
          }}
        >
          {listing?.subdirs.map((d) => (
            <li key={d.path}>
              <button type="button" className={styles.folder} onClick={() => void browse(d.path)} title={d.path}>
                <Icon name="folder" size={15} />
                <span className={styles.folderName}>{d.name}</span>
              </button>
            </li>
          ))}
          {listing && listing.subdirs.length === 0 && <li className={styles.empty}>{t('picker.empty')}</li>}
          {!listing && loading && <li className={styles.empty}>{t('picker.loading')}</li>}
        </ul>
      </div>
      <p className={styles.target} data-testid="folder-target">
        <span className={styles.targetLabel}>{t('picker.target')}</span>
        {target ? (
          <span className="mono">
            {target}
            {child && <span className={styles.newTag}>{t('picker.willCreate')}</span>}
          </span>
        ) : (
          <span className={styles.placeholder}>{t('picker.pickFolder')}</span>
        )}
      </p>
    </Dialog>
  )
}
