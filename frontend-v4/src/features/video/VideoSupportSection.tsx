import { useT } from '../../i18n'
import { Section } from '../settings/about/Section'
import styles from './VideoSupportSection.module.css'
import { installVideoSupport, useVideoSupport } from './videoApi'
import { installLabelOf, videoStatusText } from './videoStatus'

/**
 * Settings › Models: video support (ffmpeg). Says whether it is there, installs it
 * on request (about 77 MB, downloaded once, runs as a job in the Jobs drawer) and
 * tells the truth when the install fails.
 */
export function VideoSupportSection() {
  const t = useT()
  const support = useVideoSupport()
  const state = support.data
  const install = state?.install
  const running = install?.state === 'running'
  const percent = running && install?.phase === 'downloading' && install.total ? Math.min(100, Math.round(((install.downloaded ?? 0) / install.total) * 100)) : null
  const canInstall = state !== undefined && !state.available && state.can_install

  return (
    <Section title={t('video.settingsTitle')} testId="video-support">
      <p className={styles.lead} role="status" data-testid="video-support-status" data-state={install?.state === 'failed' ? 'failed' : state?.available ? 'ready' : 'missing'}>
        {support.isError ? t('video.installFailed', { reason: support.error.message }) : videoStatusText(state, t)}
      </p>
      {percent !== null && <progress className={styles.progress} max={100} value={percent} aria-label={t('video.job.running')} data-testid="video-support-progress" />}
      {canInstall && (
        <div className={styles.actions}>
          <button type="button" className="btn" disabled={running} onClick={() => void installVideoSupport()} data-testid="video-support-install">
            {installLabelOf(state, t)}
          </button>
        </div>
      )}
      <p className={styles.hint}>
        {t('video.settingsAbout')} {t('video.licence')}
      </p>
    </Section>
  )
}
