import { useT } from '../../i18n'
import { useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { IndexControls } from './IndexControls'
import { Legend } from './Legend'
import { installUmap, retryLayout, setColorBy, setSpace, useMap } from './mapStore'
import { layoutLine, SPACE_LABEL } from './status'
import styles from './StyleMap.module.css'
import { COLOR_FIELDS, SPACES, type ColorBy } from './types'

/** What places the pictures, what colours the dots, how they are laid out, and the index. */
export function Toolbar() {
  return (
    <div className={styles.toolbar} data-testid="stylemap-toolbar">
      <SpaceSwitch />
      <ColorField />
      <Legend />
      <LayoutLine />
      <IndexControls />
    </div>
  )
}

function SpaceSwitch() {
  const t = useT()
  const space = useMap((s) => s.space)
  return (
    <div className={styles.spaces} role="radiogroup" aria-label={t('stylemap.space.label')} data-testid="stylemap-space">
      {SPACES.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={space === s}
          className={styles.space}
          onClick={() => setSpace(s)}
          data-testid={`stylemap-space-${s}`}
        >
          {t(SPACE_LABEL[s])}
        </button>
      ))}
    </div>
  )
}

function ColorField() {
  const t = useT()
  const colorBy = useMap((s) => s.colorBy)
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{t('stylemap.color.label')}</span>
      <select className={styles.select} value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorBy)} data-testid="stylemap-color-by">
        {COLOR_FIELDS.map((field) => (
          <option key={field} value={field}>
            {t(`stylemap.color.${field}`)}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Quick PCA or the closer UMAP fit, with the one-click UMAP install and a retry after a failed fit. */
function LayoutLine() {
  const t = useT()
  const points = useMap((s) => s.points)
  const umap = useMap((s) => s.umap)
  const installing = useJobs((s) => s.jobs.some((j) => j.kind === 'install' && j.ctx.modelId === 'style-map-umap' && !isFinished(j.progress.status)))
  if (!points || points.status !== 'ok') return null
  const line = layoutLine(umap ?? points.umap, points.method)
  const tip = umap?.error && line.retry ? `${t(line.tip)}\n${umap.error}` : t(line.tip)
  return (
    <div className={styles.layout} role="status" title={tip} data-status={line.status} data-testid="stylemap-layout">
      <span className={styles.dot} data-tone={line.tone} aria-hidden />
      <span className={styles.layoutText}>{t(line.key)}</span>
      {line.install && (
        <button type="button" className="btn btn-sm" onClick={() => void installUmap()} disabled={installing} title={t(line.tip)} data-testid="stylemap-install-umap">
          {t('stylemap.layout.install')}
        </button>
      )}
      {line.retry && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={retryLayout} data-testid="stylemap-retry-layout">
          {t('stylemap.layout.retry')}
        </button>
      )}
    </div>
  )
}
