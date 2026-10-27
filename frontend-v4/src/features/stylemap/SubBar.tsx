import { useT } from '../../i18n'
import { LocateBox } from './LocateBox'
import { setAxesOpen, setLabels, setLandmarks, showWholeLibrary, useMap } from './mapStore'
import { scopeSentence, unlocatableCount } from './status'
import styles from './StyleMap.module.css'

/**
 * What the map covers (the library filter it draws, with a way to draw the
 * whole library), the "find a picture" box and the view switches. Each
 * switch says what pressing it will do (it flips with its state).
 */
export function SubBar() {
  const t = useT()
  const points = useMap((s) => s.points)
  const filtered = useMap((s) => s.filtered)
  const filterText = useMap((s) => s.filterText)
  const error = useMap((s) => s.error)
  const landmarksOn = useMap((s) => s.landmarksOn)
  const labelsOn = useMap((s) => s.labelsOn)
  const axesOpen = useMap((s) => s.axesOpen)

  let scope = ''
  if (error) scope = t('stylemap.loadError', { error })
  else if (points) {
    const sentence = scopeSentence(points, filtered)
    scope = t(sentence.key, sentence.params)
    const lost = unlocatableCount(points)
    if (lost > 0) scope += ` · ${t('stylemap.scope.unlocatable', { n: lost })}`
  }
  const filterLine = filtered ? t('stylemap.scope.filtered', { query: filterText }) : ''

  return (
    <div className={styles.subbar}>
      <div className={styles.scope} title={[scope, filterLine].filter(Boolean).join('\n')}>
        <p className={styles.scopeText} data-error={error ? true : undefined} role="status" data-testid="stylemap-scope">
          {scope || t('stylemap.loading')}
        </p>
        {filtered && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={showWholeLibrary} title={filterLine} data-testid="stylemap-whole-library">
            {t('stylemap.scope.wholeLibrary')}
          </button>
        )}
      </div>
      <LocateBox />
      <div className={styles.switches}>
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={axesOpen}
          aria-controls="stylemap-axes-panel"
          onClick={() => setAxesOpen(!axesOpen)}
          data-testid="stylemap-axes-toggle"
        >
          {t(axesOpen ? 'stylemap.axes.close' : 'stylemap.axes.open')}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" aria-pressed={labelsOn} onClick={() => setLabels(!labelsOn)} data-testid="stylemap-labels-toggle">
          {t(labelsOn ? 'stylemap.labels.hide' : 'stylemap.labels.show')}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" aria-pressed={landmarksOn} onClick={() => setLandmarks(!landmarksOn)} data-testid="stylemap-landmarks-toggle">
          {t(landmarksOn ? 'stylemap.landmarks.hide' : 'stylemap.landmarks.show')}
        </button>
      </div>
    </div>
  )
}
