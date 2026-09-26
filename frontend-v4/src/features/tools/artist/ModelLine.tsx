import { useModelStatus } from '../../../api/queries'
import { useApp } from '../../../state/store'
import { useArtistDiagnostics } from './artistApi'
import { artistModelState } from './artistModel'
import { useArtistPrefs } from './artistPrefs'
import styles from './Artist.module.css'
import { useAT } from './artistText'

/** One line under the run: Kaloscope is ready, will download first, needs a restart, or cannot run (and why). */
export function ModelLine() {
  const t = useAT()
  const cards = useModelStatus().data?.models
  const diagnostics = useArtistDiagnostics().data
  const local = useArtistPrefs((s) => s.modelSource === 'local')
  const state = artistModelState(cards)

  if (state === 'restart') return <p className={styles.note} data-testid="artist-model-line" data-state="restart">{t('artist.model.restart')}</p>
  if (state === 'download') {
    return (
      <p className={styles.note} data-testid="artist-model-line" data-state="download">
        {t(local ? 'artist.model.local' : 'artist.model.download')}
      </p>
    )
  }
  if (diagnostics?.available === false) {
    const missing = diagnostics.missing_dependencies ?? []
    return (
      <div className={styles.field} data-testid="artist-model-line" data-state="problem">
        <p className={styles.problem}>
          {t('artist.model.problem')} {missing.length > 0 && t('artist.model.missing', { deps: missing.join(', ') })}
        </p>
        <div className={styles.runRow}>
          <button type="button" className="btn btn-ghost" onClick={() => useApp.getState().openSettings('models')}>
            {t('artist.model.center')}
          </button>
        </div>
      </div>
    )
  }
  return (
    <p className={styles.hint} data-testid="artist-model-line" data-state="ready">
      {t('artist.model.ready')}
    </p>
  )
}
