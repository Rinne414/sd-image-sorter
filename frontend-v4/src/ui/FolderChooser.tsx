import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, unwrap } from '../api/client'
import { useT, type MessageKey } from '../i18n'
import { folderNameProblem, joinFolder, tailOfPath, type FolderNameProblem } from '../lib/paths'
import { Dialog } from './Dialog'
import styles from './FolderChooser.module.css'
import { Icon } from './Icon'
import { useLayer } from './layers'

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

/** A group of quick places on the left (where the picks live, recent folders...). */
export interface Shortcut {
  heading: string
  paths: string[]
  testId?: string
}

interface Props {
  title: string
  confirmLabel: string
  /** Where it opens; the drive list when null or unreadable. */
  start: string | null
  shortcuts: Shortcut[]
  /** Offer "New folder" (created later by whoever uses the path). */
  allowNewFolder?: boolean
  /** Called with the chosen folder; true lets the dialog close. */
  onChoose: (target: string) => Promise<boolean>
  onClose: () => void
  testId?: string
  /** Options shown under the destination (import settings, ...). */
  extra?: ReactNode
}

/** Choose a folder by browsing; typing a path also works. */
export function FolderChooser({
  title,
  confirmLabel,
  start,
  shortcuts,
  allowNewFolder = true,
  onChoose,
  onClose,
  testId = 'folder-picker',
  extra,
}: Props) {
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

  // Where the user went (or started typing) beats where the dialog meant to open:
  // the opening folder can take a second to list, and its answer must not
  // overwrite a path the user is typing.
  const userMoved = useRef(false)

  const browse = useCallback(async (path: string, opening = false): Promise<boolean> => {
    const req = ++request.current
    setLoading(true)
    setError(null)
    try {
      const res = unwrap<Listing>(await api.POST('/api/browse-folder', { body: { path } }))
      if (req !== request.current || (opening && userMoved.current)) return true
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

  const go = (path: string) => {
    userMoved.current = true
    void browse(path)
  }

  useEffect(() => {
    if (userMoved.current) return
    const from = start ?? ''
    void browse(from, true).then((ok) => {
      if (!ok && from && !userMoved.current) void browse('', true)
    })
  }, [browse, start])

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
    if (existing) go(existing.path)
    else setChild(name)
  }

  const confirm = async () => {
    if (!target || starting) return
    setStarting(true)
    const ok = await onChoose(target)
    setStarting(false)
    if (ok) onClose()
  }

  const up = () => {
    if (listing && listing.parent !== null) go(listing.parent)
  }

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
          allowNewFolder && (
            <button type="button" className="btn" onClick={() => setNaming(true)} disabled={!current}>
              {t('picker.newFolder')}
            </button>
          )
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
    <Dialog title={title} onClose={onClose} footer={footer} testId={testId} initialFocus={pathRef} wide>
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
          onChange={(e) => {
            userMoved.current = true
            setTyped(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              go(typed.trim())
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
          {shortcuts
            .filter((s) => s.paths.length > 0)
            .map((s) => (
              <div key={s.heading} className={styles.group} data-testid={s.testId}>
                <h3 className={styles.groupTitle}>{s.heading}</h3>
                {s.paths.map((p) => (
                  <button key={p} type="button" className={styles.place} onClick={() => go(p)} title={p}>
                    {tailOfPath(p, PLACE_CHARS)}
                  </button>
                ))}
              </div>
            ))}
          <div className={styles.group}>
            <button type="button" className={styles.place} onClick={() => go('')}>
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
              <button type="button" className={styles.folder} onClick={() => go(d.path)} title={d.path}>
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
      {extra}
    </Dialog>
  )
}
