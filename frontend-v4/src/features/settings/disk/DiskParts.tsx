import { useRef, useState } from 'react'
import { useT } from '../../../i18n'
import { Dialog } from '../../../ui/Dialog'
import { useToasts } from '../../../ui/toasts'
import { Section } from '../about/Section'
import { isLibKey, lt, useLT } from '../libraryText'
import styles from './Disk.module.css'
import { cleanOutcome, diskSize, initialPicks, pickedBytes, totalBytes, unknownPicked } from './disk'
import { cleanCaches, scheduleRuntimeRebuild, useCacheStatus } from './diskApi'
import type { CacheEntry, RuntimeEnvironment } from './types'

/** A folder's name in the language shown (the backend's key when it names one this page does not know). */
function itemName(key: string): string {
  const id = `disk.item.${key}`
  return isLibKey(id) ? lt(id) : key
}

function SizeText({ entry }: { entry: CacheEntry }) {
  const t = useLT()
  const size = entry.size_complete === false ? null : diskSize(entry.size_bytes)
  return (
    <span className={`${styles.itemSize} mono`} data-unknown={size === null || undefined}>
      {size ?? t('disk.size.unknown')}
    </span>
  )
}

async function clean(keys: string[]): Promise<void> {
  try {
    const { freed, errors } = cleanOutcome(await cleanCaches(keys))
    const size = diskSize(freed) ?? '0 B'
    if (errors.length > 0) {
      useToasts.getState().push(lt('disk.clean.partial', { size, n: errors.length, reason: errors[0]?.error ?? '' }), 'error')
    } else useToasts.getState().push(lt('disk.clean.done', { size }), 'info')
  } catch (error) {
    useToasts.getState().push(lt('disk.clean.failed', { reason: (error as Error).message }), 'error')
  }
}

/** Caches that are made again when needed: tick, then clean (a size that was not fully counted is asked about first). */
export function CleanSection({ entries }: { entries: CacheEntry[] }) {
  const t = useLT()
  const status = useCacheStatus()
  const [picks, setPicks] = useState(() => initialPicks(entries))
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<CacheEntry[] | null>(null)

  const toggle = (key: string, on: boolean) => {
    const next = new Set(picks)
    if (on) next.add(key)
    else next.delete(key)
    setPicks(next)
  }

  const run = async () => {
    setAsking(null)
    setBusy(true)
    await clean(entries.filter((e) => picks.has(e.key)).map((e) => e.key))
    setBusy(false)
  }

  const go = () => {
    const unknown = unknownPicked(entries, picks)
    if (unknown.length > 0) setAsking(unknown)
    else void run()
  }

  return (
    <Section title={t('disk.clean.title')} testId="disk-clean">
      <p className={styles.total}>{t('disk.clean.total', { size: diskSize(totalBytes(entries)) ?? '0 B' })}</p>
      <p className={styles.hint}>{t('disk.clean.hint')}</p>
      {entries.length === 0 ? (
        <p className={styles.hint}>{t('disk.clean.none')}</p>
      ) : (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.key}>
              <label className={styles.item} data-testid={`disk-cache-${entry.key}`}>
                <input type="checkbox" checked={picks.has(entry.key)} onChange={(e) => toggle(entry.key, e.target.checked)} />
                <span className={styles.itemName}>{itemName(entry.key)}</span>
                <SizeText entry={entry} />
                <span className={`${styles.itemPath} mono`}>{entry.path}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.row}>
        <button type="button" className="btn" onClick={go} disabled={busy || picks.size === 0} data-testid="disk-clean-go">
          {busy ? t('disk.clean.going') : t('disk.clean.go', { size: diskSize(pickedBytes(entries, picks)) ?? '0 B' })}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void status.refetch()} disabled={status.isFetching} data-testid="disk-refresh">
          {status.isFetching ? t('disk.loading') : t('disk.refresh')}
        </button>
      </div>
      {asking && <UnknownSizeDialog entries={asking} onClose={() => setAsking(null)} onGo={() => void run()} />}
    </Section>
  )
}

function UnknownSizeDialog({ entries, onClose, onGo }: { entries: CacheEntry[]; onClose: () => void; onGo: () => void }) {
  const t = useLT()
  const tm = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
        {tm('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={onGo} data-testid="disk-clean-anyway">
        {t('disk.clean.unknownOk')}
      </button>
    </>
  )
  return (
    <Dialog title={t('disk.clean.unknownTitle')} onClose={onClose} footer={footer} testId="disk-clean-unknown" initialFocus={cancelRef}>
      <p className={styles.dialogText}>{t('disk.clean.unknownBody', { names: entries.map((e) => itemName(e.key)).join(t('libset.work.join')) })}</p>
    </Dialog>
  )
}

/** Models, settings and the user's own data: shown with their sizes, folded away, never deleted here. */
export function KeptSection({ entries }: { entries: CacheEntry[] }) {
  const t = useLT()
  return (
    <details className={styles.fold} data-testid="disk-kept">
      <summary>
        <span className={styles.foldTitle}>{t('disk.kept.title')}</span>
        <span className={`${styles.foldNote} mono`}>{diskSize(totalBytes(entries)) ?? ''}</span>
      </summary>
      <div className={styles.foldBody}>
        <p className={styles.hint}>{t('disk.kept.hint')}</p>
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.key} className={styles.item} data-plain>
              <span className={styles.itemName}>{itemName(entry.key)}</span>
              <SizeText entry={entry} />
              {/* several folders come joined with "; " (all the model folders) */}
              {entry.path.split('; ').map((folder) => (
                <span key={folder} className={`${styles.itemPath} mono`}>
                  {folder}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}

/** Advanced, folded away: have the next start rebuild the light Python runtime (asked first). */
export function RuntimeSection({ runtime }: { runtime: RuntimeEnvironment }) {
  const t = useLT()
  const [asking, setAsking] = useState(false)
  const pending = runtime.rebuild_core_pending === true
  const size = diskSize(runtime.venv_size_bytes) ?? t('disk.size.unknown')
  return (
    <details className={styles.fold} data-testid="disk-advanced">
      <summary>
        <span className={styles.foldTitle}>{t('disk.advanced')}</span>
        <span className={styles.foldNote}>{t('disk.runtime.title')}</span>
      </summary>
      <div className={styles.foldBody}>
        <h4 className={styles.subTitle}>{t('disk.runtime.title')}</h4>
        <p className={styles.status} data-pending={pending || undefined} data-testid="disk-runtime-status">
          {pending ? t('disk.runtime.pending') : t('disk.runtime.size', { size })}
        </p>
        <p className={styles.hint}>{t('disk.runtime.hint')}</p>
        <div className={styles.row}>
          <button type="button" className="btn" onClick={() => setAsking(true)} disabled={pending} data-testid="disk-rebuild">
            {pending ? t('disk.runtime.pendingButton') : t('disk.runtime.button')}
          </button>
        </div>
      </div>
      {asking && <RebuildDialog size={size} onClose={() => setAsking(false)} />}
    </details>
  )
}

function RebuildDialog({ size, onClose }: { size: string; onClose: () => void }) {
  const t = useLT()
  const tm = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setBusy(true)
    try {
      await scheduleRuntimeRebuild()
      useToasts.getState().push(t('disk.runtime.done'), 'info')
      onClose()
    } catch (error) {
      useToasts.getState().push(t('disk.runtime.failed', { reason: (error as Error).message }), 'error')
      setBusy(false)
    }
  }

  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
        {tm('common.cancel')}
      </button>
      <button type="button" className="btn btn-danger" onClick={() => void go()} disabled={busy} data-testid="disk-rebuild-ok">
        {t('disk.runtime.ok')}
      </button>
    </>
  )
  return (
    <Dialog title={t('disk.runtime.confirmTitle')} onClose={onClose} footer={footer} testId="disk-rebuild-dialog" initialFocus={cancelRef}>
      <p className={styles.dialogText}>{t('disk.runtime.confirmBody', { size })}</p>
    </Dialog>
  )
}
