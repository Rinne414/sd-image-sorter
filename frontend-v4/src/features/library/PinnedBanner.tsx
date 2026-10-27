import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import styles from './PinnedBanner.module.css'
import { clearPin, usePinned } from './pinnedSet'

/** Over the grid while it shows a set of pictures sent from the Style Map: how many, and the way back to everything. */
export function PinnedBanner() {
  const t = useT()
  const pin = usePinned((s) => s.pin)
  if (!pin) return null
  return (
    <div className={styles.banner} role="status" data-testid="pinned-banner">
      <div className={styles.main}>
        <strong className={styles.title}>{t('stylemap.pin.title', { n: pin.count })}</strong>
        <span className={styles.note}>{t('stylemap.pin.note')}</span>
      </div>
      <button type="button" className="btn btn-ghost" onClick={clearPin} title={t('stylemap.pin.backTip')} data-testid="pinned-back">
        <Icon name="close" size={13} />
        {t('stylemap.pin.back')}
        <kbd>Esc</kbd>
      </button>
    </div>
  )
}
