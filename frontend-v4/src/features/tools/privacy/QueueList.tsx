import { useCallback, useState } from 'react'
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
  const result = item.result
  const shown = showing === 'result' && result ? 'result' : 'source'
  const footer = (
    <>
      {result && (
        <div className={styles.segmented} role="group" aria-label={t('privacy.preview.show')}>
          {(['source', 'result'] as const).map((s) => (
            <button key={s} type="button" className="btn" aria-pressed={shown === s} onClick={() => onShow(s)} data-testid={`privacy-preview-${s}`}>
              {t(s === 'source' ? 'privacy.item.source' : 'privacy.item.result')}
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
    <Dialog title={resultName(item.fileName, item.rename, '.png')} onClose={onClose} footer={footer} wide="x" testId="privacy-preview">
      <div className={styles.previewStage}>
        <img className={styles.previewImage} src={shown === 'result' ? result!.url : sourceSrc(item, true)} alt={t(shown === 'result' ? 'privacy.item.result' : 'privacy.item.source')} data-testid="privacy-preview-image" data-showing={shown} />
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
