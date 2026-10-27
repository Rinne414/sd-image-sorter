import { useCallback, useState } from 'react'
import { useT } from '../../../i18n'
import { Dialog } from '../../../ui/Dialog'
import styles from './Privacy.module.css'
import { usePT } from './privacyText'
import { usePrivacy, type QueueItem } from './privacyStore'
import { QueueCard, sourceSrc, type Showing } from './QueueCard'
import { resultName } from './names'
import { copyItem, downloadItem } from './share'

// The queue as a grid of cards, and the large preview a thumbnail opens.

function Preview({ item, showing, onShow, onClose }: { item: QueueItem; showing: Showing; onShow: (s: Showing) => void; onClose: () => void }) {
  const t = usePT()
  const d = useT()
  const result = item.result
  // a disguise shows the cover (what a chat list shows); the real picture is the original
  const resultLabel = result?.disguise ? d('disguise.item.cover') : t('privacy.item.result')
  const resultUrl = result?.disguise?.coverUrl ?? result?.url
  const shown = showing === 'result' && result ? 'result' : 'source'
  const footer = (
    <>
      {result && (
        <div className={styles.segmented} role="group" aria-label={t('privacy.preview.show')}>
          {(['source', 'result'] as const).map((s) => (
            <button key={s} type="button" className="btn" aria-pressed={shown === s} onClick={() => onShow(s)} data-testid={`privacy-preview-${s}`}>
              {s === 'source' ? t('privacy.item.source') : resultLabel}
            </button>
          ))}
        </div>
      )}
      <span className={styles.footGap} />
      <button type="button" className="btn" onClick={() => void copyItem(item)} disabled={!result} data-testid="privacy-preview-copy">
        {t('privacy.preview.copy')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void downloadItem(item)} disabled={!result} data-testid="privacy-preview-download">
        {t('privacy.preview.download')}
      </button>
    </>
  )
  return (
    <Dialog title={result?.disguise?.fileName ?? resultName(item.fileName, item.rename, '.png')} onClose={onClose} footer={footer} wide="x" testId="privacy-preview">
      <div className={styles.previewStage}>
        <img className={styles.previewImage} src={shown === 'result' ? resultUrl : sourceSrc(item, true)} alt={shown === 'result' ? resultLabel : t('privacy.item.source')} data-testid="privacy-preview-image" data-showing={shown} />
      </div>
    </Dialog>
  )
}

export function QueueList() {
  const items = usePrivacy((s) => s.items)
  const [open, setOpen] = useState<{ key: number; showing: Showing } | null>(null)
  const onOpen = useCallback((key: number, showing: Showing) => setOpen({ key, showing }), [])
  const openItem = open ? items.find((it) => it.key === open.key) : undefined

  return (
    <div className={styles.list} data-testid="privacy-queue">
      <ul className={styles.grid}>
        {items.map((item) => (
          <QueueCard key={item.key} item={item} onOpen={onOpen} />
        ))}
      </ul>
      {open && openItem && <Preview item={openItem} showing={open.showing} onShow={(showing) => setOpen({ ...open, showing })} onClose={() => setOpen(null)} />}
    </div>
  )
}
