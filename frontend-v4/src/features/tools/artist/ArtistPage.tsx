import { useEffect } from 'react'
import { useJobs } from '../../jobs/jobs'
import { isFinished } from '../../jobs/progress'
import { takeHandoff, useHandoff } from '../handoff'
import { ArtistDetail } from './ArtistDetail'
import { ArtistList } from './ArtistList'
import styles from './Artist.module.css'
import { useAT } from './artistText'
import { setSent } from './artistView'
import { ClearBlock } from './ClearBlock'
import { RunPanel } from './RunPanel'
import { SettingsBlock } from './SettingsBlock'
import { StatsBar } from './StatsBar'
import { VocabularyCheck } from './VocabularyCheck'

/** Library images sent with "送到工具 ▸ 画风识别": they become the images to identify. */
function useLibraryHandoff(): void {
  const pending = useHandoff((s) => s.pending)
  useEffect(() => {
    if (pending?.tool !== 'artist') return
    const ids = takeHandoff('artist')
    if (ids?.length) setSent(ids)
  }, [pending])
}

/** 画风识别: is the artist in the vocabulary, identify, and what was found. */
export function ArtistPage() {
  const t = useAT()
  const running = useJobs((s) => s.jobs.some((j) => j.kind === 'artist' && !isFinished(j.progress.status)))
  useLibraryHandoff()

  return (
    <div className={styles.page} data-testid="artist-page">
      <aside className={styles.side} data-testid="artist-side">
        <p className={styles.what}>{t('artist.what')}</p>
        <VocabularyCheck />
        <RunPanel />
        <SettingsBlock locked={running} />
        <ClearBlock locked={running} />
      </aside>
      <div className={styles.main}>
        <StatsBar />
        <div className={styles.results}>
          <ArtistList />
          <ArtistDetail />
        </div>
      </div>
    </div>
  )
}
