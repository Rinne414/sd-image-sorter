import { useRef, useState } from 'react'
import { ApiError } from '../../../api/client'
import { useLibraries } from '../../../api/queries'
import { useT } from '../../../i18n'
import { useApp } from '../../../state/store'
import { Dialog } from '../../../ui/Dialog'
import { useToasts } from '../../../ui/toasts'
import { tr, useJobs } from '../../jobs/jobs'
import { lt, useLT, type LibKey } from '../libraryText'
import { refusedWorks, worksText, type BusyWork, type Work } from './clearIndex'
import { clearFacts, clearIndex, probeBusy, stopWork, type ClearFacts } from './libraryApi'
import styles from './LibrarySettings.module.css'

const STOP_KEYS: Record<BusyWork['work'], LibKey> = {
  scan: 'libset.clear.stop.scan',
  tag: 'libset.clear.stop.tag',
  aesthetic: 'libset.clear.stop.aesthetic',
}

/** Looks again this often after asking a job to stop, this many times. */
const RECHECK_MS = 1500
const RECHECKS = 10

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
const fail = (key: LibKey, error: unknown) => useToasts.getState().push(lt(key, { reason: (error as Error).message }), 'error')

/**
 * At the bottom, set apart: clearing the library's index. It first checks what
 * would be in the way (and offers to stop it), then counts what would be lost
 * and asks with Cancel focused.
 */
export function ClearSection() {
  const t = useLT()
  const libraryId = useApp((s) => s.libraryId)
  const library = useLibraries().data?.libraries.find((l) => l.id === libraryId)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState<BusyWork[]>([])
  const [refused, setRefused] = useState<Work[]>([])
  const [facts, setFacts] = useState<ClearFacts | null>(null)

  const start = async () => {
    setChecking(true)
    setRefused([])
    const inWay = await probeBusy().catch((error: unknown) => {
      fail('libset.clear.probeFailed', error)
      return null
    })
    if (inWay) setBusy(inWay)
    if (inWay?.length === 0) {
      try {
        setFacts(await clearFacts())
      } catch (error) {
        fail('libset.clear.countFailed', error)
      }
    }
    setChecking(false)
  }

  const onRefused = (works: Work[]) => {
    setRefused(works)
    void probeBusy().then(setBusy, () => undefined)
  }

  const onBusy = (now: BusyWork[]) => {
    setBusy(now)
    if (now.length === 0) setRefused([])
  }

  return (
    <section className={styles.danger} aria-labelledby="libset-clear-title" data-testid="libset-clear">
      <h3 id="libset-clear-title" className={styles.dangerTitle}>
        {t('libset.clear.title')}
      </h3>
      <p className={styles.lead}>{t('libset.clear.lead', { name: library?.name ?? libraryId, n: library?.image_count ?? 0 })}</p>
      <div className={styles.row}>
        <button type="button" className="btn btn-danger" onClick={() => void start()} disabled={checking} data-testid="clear-index">
          {checking ? t('libset.clear.checking') : t('libset.clear.button')}
        </button>
      </div>
      {(busy.length > 0 || refused.length > 0) && <InTheWay busy={busy} refused={refused} onBusy={onBusy} />}
      {facts && <ClearDialog facts={facts} onClose={() => setFacts(null)} onRefused={onRefused} />}
    </section>
  )
}

/** What keeps the index from being cleared, each with its stop button (work V4 cannot stop here opens the Jobs drawer). */
function InTheWay({ busy, refused, onBusy }: { busy: BusyWork[]; refused: Work[]; onBusy: (busy: BusyWork[]) => void }) {
  const t = useLT()
  const [stopping, setStopping] = useState<BusyWork['work'] | null>(null)

  const stop = async (item: BusyWork) => {
    setStopping(item.work)
    try {
      await stopWork(item)
      for (let i = 0; i < RECHECKS; i++) {
        await sleep(RECHECK_MS)
        const now = await probeBusy()
        onBusy(now)
        if (!now.some((b) => b.work === item.work)) break
      }
    } catch (error) {
      useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
    } finally {
      setStopping(null)
    }
  }

  const text = refused.length > 0 ? t('libset.clear.refused', { work: worksText(refused, t) }) : t('libset.clear.busy', { work: worksText(busy.map((b) => b.work), t) })
  return (
    <div className={styles.busy} role="status" data-testid="clear-busy">
      <p>{text}</p>
      <div className={styles.row}>
        {busy.map((item) => (
          <button key={item.work} type="button" className="btn" onClick={() => void stop(item)} disabled={stopping !== null} data-testid={`clear-stop-${item.work}`}>
            {stopping === item.work ? t('libset.clear.stopping') : t(STOP_KEYS[item.work])}
          </button>
        ))}
        <button type="button" className="btn btn-ghost" onClick={() => useJobs.getState().setDrawerOpen(true)}>
          {t('libset.clear.openJobs')}
        </button>
      </div>
    </div>
  )
}

function ClearDialog({ facts, onClose, onRefused }: { facts: ClearFacts; onClose: () => void; onRefused: (works: Work[]) => void }) {
  const t = useLT()
  const tm = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setBusy(true)
    try {
      await clearIndex(facts)
      onClose()
    } catch (error) {
      setBusy(false)
      if (error instanceof ApiError && error.status === 409) {
        onRefused(refusedWorks(error.body))
        onClose()
      } else if (error instanceof ApiError && error.status === 503) fail('libset.clear.unknown', error)
      else useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
    }
  }

  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
        {tm('common.cancel')}
      </button>
      <button type="button" className="btn btn-danger" onClick={() => void go()} disabled={busy} data-testid="clear-index-ok">
        {t('libset.clear.ok', { n: facts.records })}
      </button>
    </>
  )

  return (
    <Dialog title={t('libset.clear.dialogTitle', { name: facts.name })} onClose={onClose} footer={footer} testId="clear-index-dialog" initialFocus={cancelRef}>
      <div className={styles.dialogText} data-testid="clear-index-facts">
        <p className={styles.strong}>{t('libset.clear.records', { n: facts.records })}</p>
        <p>{t('libset.clear.lose', { tagged: facts.tagged, rated: facts.rated })}</p>
        {facts.favorites > 0 && <p>{t('libset.clear.favs', { fav: facts.favorites })}</p>}
        <p>{t('libset.clear.keep')}</p>
        <p className={styles.muted}>{t('libset.clear.tip')}</p>
      </div>
    </Dialog>
  )
}
