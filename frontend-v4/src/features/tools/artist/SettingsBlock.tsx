import { useId } from 'react'
import { MODEL_SOURCES, resetArtistPrefs, setArtistPrefs, THRESHOLD_MAX, useArtistPrefs, type ModelSource } from './artistPrefs'
import styles from './Artist.module.css'
import { useAT, type ArtistKey } from './artistText'

// Where the model comes from, the confidence floor and the graphics card:
// saved as they change (no Save button), used by every run.

const SOURCE_KEY: Record<ModelSource, ArtistKey> = {
  huggingface: 'artist.source.huggingface',
  modelscope: 'artist.source.modelscope',
  local: 'artist.source.local',
}

export function SettingsBlock({ locked }: { locked: boolean }) {
  const t = useAT()
  const prefs = useArtistPrefs()
  const sourceId = useId()
  const pathId = useId()
  const thresholdId = useId()
  const pathMissing = prefs.modelSource === 'local' && !prefs.modelPath.trim()

  return (
    <section className={styles.block}>
      <h3 className={styles.blockTitle}>{t('artist.settings.title')}</h3>
      <p className={styles.hint}>{t('artist.settings.remembered')}</p>
      <fieldset className={styles.plain} disabled={locked} data-testid="artist-settings">
        <div className={styles.field}>
          <label className={styles.subLabel} htmlFor={sourceId}>
            {t('artist.source')}
          </label>
          <select
            id={sourceId}
            className={styles.select}
            value={prefs.modelSource}
            onChange={(e) => setArtistPrefs({ modelSource: e.target.value as ModelSource })}
            data-testid="artist-source"
          >
            {MODEL_SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(SOURCE_KEY[s])}
              </option>
            ))}
          </select>
        </div>
        {prefs.modelSource === 'local' && (
          <div className={styles.field}>
            <label className={styles.subLabel} htmlFor={pathId}>
              {t('artist.path')}
            </label>
            <input
              id={pathId}
              className={`${styles.input} mono`}
              value={prefs.modelPath}
              spellCheck={false}
              onChange={(e) => setArtistPrefs({ modelPath: e.target.value })}
              data-testid="artist-path"
            />
            {pathMissing && <p className={styles.problem}>{t('artist.path.missing')}</p>}
          </div>
        )}
        <div className={styles.field}>
          <div className={styles.fieldHead}>
            <label className={styles.subLabel} htmlFor={thresholdId}>
              {t('artist.threshold')}
            </label>
            <span className="mono">{prefs.threshold.toFixed(2)}</span>
          </div>
          <input
            id={thresholdId}
            className={styles.range}
            type="range"
            min={0}
            max={THRESHOLD_MAX}
            step={0.01}
            value={prefs.threshold}
            onChange={(e) => setArtistPrefs({ threshold: Number(e.target.value) })}
            data-testid="artist-threshold"
          />
          <p className={styles.hint}>{t('artist.threshold.hint')}</p>
        </div>
        <label className={styles.check}>
          <input type="checkbox" checked={prefs.useGpu} onChange={(e) => setArtistPrefs({ useGpu: e.target.checked })} data-testid="artist-gpu" />
          <span>
            <span>{t('artist.gpu')}</span>
            <span className={styles.hint}>{t('artist.gpu.hint')}</span>
          </span>
        </label>
        <div className={styles.runRow}>
          <button type="button" className="btn btn-ghost" onClick={resetArtistPrefs} data-testid="artist-reset">
            {t('artist.reset')}
          </button>
        </div>
      </fieldset>
    </section>
  )
}
