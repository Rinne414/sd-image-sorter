import { useEffect } from 'react'
import introStyles from '../intake/Intake.module.css'
import { IntakeButtonsMany } from '../intake/Intake'
import { useIntakeFiles } from '../intake/useIntake'
import { takeHandoff, useHandoff } from '../handoff'
import styles from './Privacy.module.css'
import { usePT } from './privacyText'
import { usePrivacy } from './privacyStore'
import { QueueBar } from './QueueBar'
import { QueueList } from './QueueList'
import { addFiles, addLibraryImages } from './queueIntake'
import { SettingsPanel } from './SettingsPanel'

/** Library images sent with "送到工具 ▸ 隐私混淆": added once, when they arrive. */
function useLibraryHandoff(): void {
  const pending = useHandoff((s) => s.pending)
  useEffect(() => {
    if (pending?.tool !== 'privacy') return
    const ids = takeHandoff('privacy')
    if (ids?.length) void addLibraryImages(ids)
  }, [pending])
}

function EmptyQueue() {
  const t = usePT()
  return (
    <section className={introStyles.zone} data-testid="intake-zone">
      <div className={introStyles.frame} aria-hidden />
      <p className={introStyles.lead}>{t('privacy.lead')}</p>
      <div className={introStyles.buttons}>
        <IntakeButtonsMany onFiles={addFiles} pickLabel={t('privacy.pick')} primary />
      </div>
      <p className={introStyles.hint}>{t('privacy.hint')}</p>
    </section>
  )
}

/** 隐私混淆: scramble many images for sharing (Big / Small Tomato compatible), or restore them. */
export function PrivacyPage() {
  const t = usePT()
  const hasItems = usePrivacy((s) => s.items.length > 0)
  const over = useIntakeFiles('privacy', addFiles)
  useLibraryHandoff()

  return (
    <div className={styles.page} data-testid="privacy-page">
      <SettingsPanel />
      <div className={styles.main}>
        {hasItems ? (
          <>
            <QueueBar />
            <QueueList />
          </>
        ) : (
          <EmptyQueue />
        )}
      </div>
      {over && (
        <div className={introStyles.overlay} aria-hidden data-testid="intake-drop-overlay">
          <p className={introStyles.overlayText}>{t('privacy.dropHere')}</p>
        </div>
      )}
    </div>
  )
}
