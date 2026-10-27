import { useState } from 'react'
import { useT } from '../../i18n'
import styles from './VideoBanner.module.css'
import { installVideoSupport, useLibraryVideoCount, useVideoSupport } from './videoApi'
import { installLabelOf, videoStatusText } from './videoStatus'

const DISMISS_KEY = 'sd-v4-video-banner-dismissed'

function wasDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Shown above the library while it holds videos but ffmpeg is missing: without it
 * they are listed by name, size and date only. Offers the install; "Not now"
 * hides it until the program is opened again.
 */
export function VideoBanner() {
  const t = useT()
  const videos = useLibraryVideoCount()
  const support = useVideoSupport()
  const [dismissed, setDismissed] = useState(wasDismissed)
  const state = support.data
  if (dismissed || !state || state.available || videos === 0) return null

  const running = state.install.state === 'running'
  const showStatus = running || state.install.state === 'failed'
  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // storage blocked: it hides for now
    }
    setDismissed(true)
  }
  return (
    <div className={styles.banner} role="status" data-testid="video-banner">
      <div className={styles.copy}>
        <strong>{t('video.bannerTitle', { n: videos })}</strong>
        <span>{showStatus ? videoStatusText(state, t) : t('video.bannerDetail', { from: state.download_from })}</span>
      </div>
      {state.can_install && (
        <button type="button" className="btn btn-primary" disabled={running} onClick={() => void installVideoSupport()} data-testid="video-banner-install">
          {installLabelOf(state, t)}
        </button>
      )}
      <button type="button" className="btn btn-ghost" onClick={dismiss} data-testid="video-banner-dismiss">
        {t('video.bannerDismiss')}
      </button>
    </div>
  )
}
