import { memo, useState } from 'react'
import { thumbnailUrl } from '../../../api/urls'
import { useT } from '../../../i18n'
import { revealMadeFile } from './disguise/disguiseShare'
import { formatBytes } from './disguise/disguiseModel'
import disguiseStyles from './disguise/Disguise.module.css'
import { problemText as serverProblemText, reasonText } from './disguise/disguiseText'
import { isHuge, megapixels } from './engine/imageSize'
import { stemOf } from './names'
import styles from './Privacy.module.css'
import { usePT, type PrivacyKey } from './privacyText'
import { removeItem, renameItem, usePrivacy, type QueueItem } from './privacyStore'
import { copyItem, downloadItem, dragResult } from './share'

// One image in the queue: the original and the result side by side, the name
// it is handed out under, what happened to it, and what to do with the result.

export type Showing = 'source' | 'result'

/** The picture shown for the original: the file itself, or the library's thumbnail. */
export const sourceSrc = (item: QueueItem, large = false): string =>
  item.source.kind === 'file' ? item.source.url : large ? `/api/image-file/${item.source.id}` : thumbnailUrl(item.source.id, 256)

/** The name a download gets; typed freely, kept on Enter or leaving the field (empty goes back to the original's). */
function NameField({ item }: { item: QueueItem }) {
  const t = usePT()
  const shown = item.rename ?? stemOf(item.fileName)
  const [draft, setDraft] = useState(shown)
  const mode = usePrivacy((s) => s.options.mode)
  const simple = item.result ? item.result.compat === 'small_tomato' : mode === 'simple'
  const commit = () => {
    if (draft.trim() !== shown) renameItem(item.key, draft)
  }
  return (
    <label className={styles.name}>
      <input
        className={styles.nameInput}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        aria-label={t('privacy.item.name')}
        title={t('privacy.item.name')}
        data-testid="privacy-item-name"
      />
      <span className={styles.ext}>{simple ? '.jpg' : '.png'}</span>
    </label>
  )
}

/** "PNG", "JPG", "WEBP"… from the original's name (two files can share a stem). */
const formatOf = (fileName: string): string => /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toUpperCase() ?? ''

function statusText(item: QueueItem, t: ReturnType<typeof usePT>, d: ReturnType<typeof useT>): string {
  if (item.state === 'working') return t('privacy.item.working')
  if (item.state === 'failed') return t('privacy.item.failed', { reason: problemText(item, t) })
  if (item.state === 'needs-cover') return d('disguise.item.needsCover', { reason: reasonText(item.problem?.detail ?? '') })
  if (item.state === 'packed') return d('disguise.item.packed')
  if (!item.result) return t('privacy.item.waiting')
  const made = item.result.disguise
  if (made) return d('disguise.item.done', { width: made.width, height: made.height, size: formatBytes(made.bytes) })
  if (item.result.restored) return d('disguise.item.restored')
  const mode = t(item.result.compat === 'small_tomato' ? 'privacy.mode.simple.short' : 'privacy.mode.standard.short')
  const done = t(item.result.direction === 'encode' ? 'privacy.item.encoded' : 'privacy.item.decoded', { mode })
  return item.result.carried ? `${done} · ${t('privacy.item.carried')}` : done
}

const PROBLEM: Record<string, PrivacyKey> = { decode: 'privacy.err.decode', 'too-small': 'privacy.err.tooSmall', library: 'privacy.err.library', encode: 'privacy.err.encode' }

function problemText(item: QueueItem, t: ReturnType<typeof usePT>): string {
  const problem = item.problem
  if (!problem) return ''
  if (problem.code === 'server') return serverProblemText(problem.status, problem.detail)
  return t(PROBLEM[problem.code] ?? 'privacy.err.encode', { detail: problem.detail })
}

type OnOpen = (key: number, showing: Showing) => void

function Pictures({ item, onOpen }: { item: QueueItem; onOpen: OnOpen }) {
  const t = usePT()
  const d = useT()
  const result = item.result
  // a file the browser cannot show gets words instead of the broken-image icon
  const [unreadable, setUnreadable] = useState(false)
  return (
    <div className={styles.pair}>
      <button type="button" className={styles.thumb} onClick={() => onOpen(item.key, 'source')} title={t('privacy.item.open')} data-testid="privacy-item-source">
        {unreadable ? (
          <span className={styles.noPreview}>{t('privacy.item.noPreview')}</span>
        ) : (
          <img src={sourceSrc(item)} alt={t('privacy.item.source')} loading="lazy" decoding="async" draggable={false} onError={() => setUnreadable(true)} />
        )}
      </button>
      <span className={styles.arrow} aria-hidden>
        →
      </span>
      {result ? (
        <button type="button" className={styles.thumb} onClick={() => onOpen(item.key, 'result')} title={`${t('privacy.item.open')} · ${t('privacy.item.dragOut')}`} data-testid="privacy-item-result">
          <img src={result.disguise?.coverUrl ?? result.url} alt={result.disguise ? d('disguise.item.cover') : t('privacy.item.result')} decoding="async" draggable onDragStart={(e) => dragResult(e, item)} />
        </button>
      ) : (
        <div className={styles.placeholder} data-working={item.state === 'working' || undefined}>
          {t(item.state === 'working' ? 'privacy.item.working' : 'privacy.item.noResult')}
        </div>
      )}
    </div>
  )
}

/** Only a card whose image changed renders again, so a long queue stays quick during a run. */
export const QueueCard = memo(function QueueCard({ item, onOpen }: { item: QueueItem; onOpen: OnOpen }) {
  const t = usePT()
  const d = useT()
  const made = item.result?.disguise
  const hasResult = !!item.result
  const blockedTitle = hasResult ? undefined : t('privacy.item.processFirst')
  return (
    <li className={styles.card} data-state={item.state} data-testid="privacy-item" data-key={item.key}>
      <Pictures item={item} onOpen={onOpen} />
      {/* a new name from elsewhere (or a reset to the original's) starts a fresh draft */}
      <NameField key={item.rename ?? item.fileName} item={item} />
      <p className={item.state === 'failed' ? styles.statusProblem : styles.status} data-testid="privacy-item-status">
        {statusText(item, t, d)}
      </p>
      {made && (
        <p className={disguiseStyles.saved} data-testid="disguise-item-saved">
          {d('disguise.item.saved', { path: made.outputPath })}
        </p>
      )}
      <p className={styles.meta}>
        {item.source.kind === 'library' && <span className={styles.badge}>{t('privacy.item.fromLibrary')}</span>}
        <span>{formatOf(item.fileName)}</span>
        {item.size && <span className="mono">{`${item.size.width} × ${item.size.height}`}</span>}
      </p>
      {isHuge(item.size) && item.size && (
        <p className={styles.warnText} data-testid="privacy-item-huge">
          {t('privacy.item.huge', { mp: megapixels(item.size).toFixed(1) })}
        </p>
      )}
      <div className={styles.actions}>
        <button type="button" className="btn" onClick={() => void copyItem(item)} disabled={!hasResult} title={blockedTitle ?? (made ? d('disguise.item.copy.hint') : t('privacy.item.copy.hint'))} data-testid="privacy-item-copy">
          {t('privacy.item.copy')}
        </button>
        <button type="button" className="btn" onClick={() => void downloadItem(item)} disabled={!hasResult} title={blockedTitle} data-testid="privacy-item-download">
          {t('privacy.item.download')}
        </button>
        {made && (
          <button type="button" className="btn" onClick={() => void revealMadeFile(made.token)} title={d('disguise.item.reveal.hint')} data-testid="disguise-item-reveal">
            {d('disguise.item.reveal')}
          </button>
        )}
        <button type="button" className={`btn btn-ghost ${styles.remove}`} onClick={() => removeItem(item.key)} disabled={item.state === 'working'} data-testid="privacy-item-remove">
          {t('privacy.item.remove')}
        </button>
      </div>
    </li>
  )
})
