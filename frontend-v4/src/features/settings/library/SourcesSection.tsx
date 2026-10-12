import { useRef, useState } from 'react'
import { useT } from '../../../i18n'
import { Dialog } from '../../../ui/Dialog'
import { useSelectionDialog } from '../../selection/dialogs'
import { Section } from '../about/Section'
import { useLT } from '../libraryText'
import { removeRoot, removeRoots, rescanRoot, useLibraryRoots } from './libraryApi'
import styles from './LibrarySettings.module.css'
import { missingRoots, orderRoots, rootsSummary, scannedAt } from './roots'
import type { LibraryRoot } from './types'

/** The folders this library imports from: rescan one (a job), or stop using one as a source. */
export function SourcesSection() {
  const t = useLT()
  const roots = useLibraryRoots()
  const [removing, setRemoving] = useState<LibraryRoot | null>(null)
  const [removingMissing, setRemovingMissing] = useState(false)
  const list = orderRoots(roots.data ?? [])
  const { folders, missing } = rootsSummary(list)

  return (
    <Section title={t('libset.sources.title')} testId="libset-sources">
      <p className={styles.lead}>{t('libset.sources.lead')}</p>
      <div className={styles.bar}>
        <span className={styles.count} data-missing={missing > 0 || undefined} data-testid="roots-summary">
          {roots.data ? (missing > 0 ? t('libset.sources.summaryMissing', { folders, missing }) : t('libset.sources.summary', { folders })) : ''}
        </span>
        <span className={styles.barActions}>
          {missing > 0 && (
            <button type="button" className="btn" onClick={() => setRemovingMissing(true)} data-testid="roots-remove-missing">
              {t('libset.removeMissing.button', { n: missing })}
            </button>
          )}
          <button type="button" className="btn" onClick={() => useSelectionDialog.getState().showFor('import', null, 1)} data-testid="roots-add">
            {t('libset.sources.add')}
          </button>
        </span>
      </div>
      {roots.isPending && <p className={styles.state}>{t('libset.sources.loading')}</p>}
      {roots.isError && (
        <p className={styles.state} data-tone="error">
          {t('libset.sources.failed', { reason: roots.error.message })}{' '}
          <button type="button" className="btn btn-ghost" onClick={() => void roots.refetch()}>
            {t('libset.retry')}
          </button>
        </p>
      )}
      {roots.data && list.length === 0 && <p className={styles.state}>{t('libset.sources.empty')}</p>}
      {list.length > 0 && (
        <ul className={styles.roots} data-testid="roots">
          {list.map((root) => (
            <RootRow key={root.id} root={root} onRemove={() => setRemoving(root)} />
          ))}
        </ul>
      )}
      {removing && <RemoveDialog root={removing} onClose={() => setRemoving(null)} />}
      {removingMissing && <RemoveMissingDialog roots={missingRoots(list)} onClose={() => setRemovingMissing(false)} />}
    </Section>
  )
}

function RootRow({ root, onRemove }: { root: LibraryRoot; onRemove: () => void }) {
  const t = useLT()
  const [busy, setBusy] = useState(false)
  const gone = root.exists === false
  const when = scannedAt(root.last_scanned_at)

  const rescan = async () => {
    setBusy(true)
    await rescanRoot(root)
    setBusy(false)
  }

  return (
    <li className={styles.root} data-missing={gone || undefined} data-testid="root-row">
      <div className={styles.rootText}>
        <span className={`${styles.rootPath} mono`} title={root.path}>
          {root.path}
        </span>
        <span className={styles.rootMeta}>
          {gone && (
            <span className={styles.missing} title={t('libset.root.missingHint')}>
              {t('libset.root.missing')}
            </span>
          )}
          <span>{t('libset.root.images', { n: root.image_count })}</span>
          <span>{when ? t('libset.root.scanned', { when }) : t('libset.root.never')}</span>
        </span>
      </div>
      <div className={styles.rootActions}>
        <button type="button" className="btn" onClick={() => void rescan()} disabled={gone || busy} data-testid="root-rescan">
          {t('libset.root.rescan')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onRemove} data-testid="root-remove">
          {t('libset.root.remove')}
        </button>
      </div>
    </li>
  )
}

/** Removing a source keeps its images and files, but still asks (focus on Cancel). */
function RemoveDialog({ root, onClose }: { root: LibraryRoot; onClose: () => void }) {
  const t = useLT()
  const tm = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setBusy(true)
    const ok = await removeRoot(root)
    setBusy(false)
    if (ok) onClose()
  }

  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
        {tm('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void go()} disabled={busy} data-testid="root-remove-ok">
        {t('libset.remove.ok')}
      </button>
    </>
  )

  return (
    <Dialog title={t('libset.remove.title')} onClose={onClose} footer={footer} testId="root-remove-dialog" initialFocus={cancelRef}>
      <p className={styles.lead}>{t('libset.remove.body', { path: root.path, n: root.image_count })}</p>
    </Dialog>
  )
}

/** Every folder that is gone, at once: the count and each path, focus on Cancel. Images and files stay. */
function RemoveMissingDialog({ roots, onClose }: { roots: readonly LibraryRoot[]; onClose: () => void }) {
  const t = useLT()
  const tm = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const images = roots.reduce((n, r) => n + r.image_count, 0)

  const go = async () => {
    setBusy(true)
    await removeRoots(roots)
    setBusy(false)
    onClose()
  }

  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
        {tm('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void go()} disabled={busy || roots.length === 0} data-testid="roots-remove-missing-ok">
        {busy ? t('libset.removeMissing.working') : t('libset.removeMissing.ok', { n: roots.length })}
      </button>
    </>
  )

  return (
    <Dialog title={t('libset.removeMissing.title', { n: roots.length })} onClose={onClose} footer={footer} testId="roots-remove-missing-dialog" initialFocus={cancelRef}>
      <p className={styles.lead}>{t('libset.removeMissing.body', { n: roots.length, images })}</p>
      <ul className={styles.gone} data-testid="roots-remove-missing-list">
        {roots.map((root) => (
          <li key={root.id} className="mono" title={root.path}>
            {root.path}
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
