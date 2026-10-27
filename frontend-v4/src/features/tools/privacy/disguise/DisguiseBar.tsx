import { useMemo } from 'react'
import { useT } from '../../../../i18n'
import { usePrivacy } from '../privacyStore'
import styles from './Disguise.module.css'
import { formatBytes, folderOf } from './disguiseModel'
import { redoWithDefaultCover } from './disguiseRun'
import { copyMade, revealMadeFile } from './disguiseShare'
import { chooseDefaultCover, refreshDefaultCover, useDisguise, type PackResult } from './disguiseStore'
import { reasonText } from './disguiseText'

// Between the queue's header and the queue: the pictures waiting for another
// cover (with the way out), and the packed file a pack run made.

/** Use the default cover; when none is saved yet, choose one first and carry on. */
async function redo(scope: 'failed' | 'all'): Promise<void> {
  if (!(await refreshDefaultCover()) && !(await chooseDefaultCover())) return
  await redoWithDefaultCover(scope)
}

function NeedsCover() {
  const t = useT()
  const running = usePrivacy((s) => s.run !== null)
  const items = usePrivacy((s) => s.items)
  const waiting = useMemo(() => items.filter((it) => it.state === 'needs-cover'), [items])
  if (!waiting.length) return null
  const reasons = [...new Set(waiting.map((it) => reasonText(it.problem?.detail ?? '')))].join('; ')
  return (
    <div className={styles.needsCover} role="status" data-testid="disguise-needs-cover">
      <span className={styles.needsCoverText} data-testid="disguise-needs-cover-text">
        {t('disguise.bar.needsCover', { n: waiting.length, reasons })}
      </span>
      <button type="button" className="btn" onClick={() => void redo('failed')} disabled={running} data-testid="disguise-redo-failed">
        {t('disguise.bar.redoFailed')}
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => void redo('all')} disabled={running} data-testid="disguise-redo-all">
        {t('disguise.bar.redoAll')}
      </button>
    </div>
  )
}

function download(pack: PackResult): void {
  const link = document.createElement('a')
  link.href = pack.url
  link.download = pack.fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function Pack({ pack }: { pack: PackResult }) {
  const t = useT()
  return (
    <div className={styles.pack} data-testid="disguise-pack-result">
      <img className={styles.packThumb} src={pack.coverUrl} alt={t('disguise.pack.coverAlt')} />
      <div className={styles.packText}>
        <span className={styles.packName} data-testid="disguise-pack-info">
          {t('disguise.pack.info', { name: pack.fileName, frames: pack.frames, width: pack.width, height: pack.height, size: formatBytes(pack.bytes) })}
        </span>
        <span title={folderOf(pack.outputPath)} data-testid="disguise-pack-saved">
          {t('disguise.pack.saved', { path: pack.outputPath })}
        </span>
      </div>
      <div className={styles.packActions}>
        <button type="button" className="btn btn-primary" onClick={() => void copyMade([pack.token])} title={t('disguise.item.copy.hint')} data-testid="disguise-pack-copy">
          {t('disguise.pack.copy')}
        </button>
        <button type="button" className="btn" onClick={() => download(pack)} data-testid="disguise-pack-download">
          {t('disguise.pack.download')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void revealMadeFile(pack.token)} title={t('disguise.item.reveal.hint')} data-testid="disguise-pack-reveal">
          {t('disguise.item.reveal')}
        </button>
      </div>
    </div>
  )
}

export function DisguiseNotices() {
  const pack = useDisguise((s) => s.pack)
  const waiting = usePrivacy((s) => s.items.some((it) => it.state === 'needs-cover'))
  if (!pack && !waiting) return null
  return (
    <div className={styles.notices}>
      <NeedsCover />
      {pack && <Pack pack={pack} />}
    </div>
  )
}

/** "Copy all as files": every made disguise (and the packed file) in one paste. */
export function CopyAllButton() {
  const t = useT()
  const items = usePrivacy((s) => s.items)
  const tokens = useMemo(() => items.map((it) => it.result?.disguise?.token).filter((x): x is string => !!x), [items])
  const pack = useDisguise((s) => s.pack)
  const all = pack ? [pack.token, ...tokens] : tokens
  if (!all.length) return null
  return (
    <button type="button" className="btn" onClick={() => void copyMade(all)} title={t('disguise.item.copy.hint')} data-testid="disguise-copy-all">
      {t('disguise.copyAll')}
    </button>
  )
}
