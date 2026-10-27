import { useState } from 'react'
import { thumbnailUrl } from '../../api/urls'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { useLayer } from '../../ui/layers'
import { retryAxes, setAxesOpen, setPreview, useMap } from './mapStore'
import styles from './MapCanvas.module.css'
import { getScene } from './sceneHandle'
import { tagName } from './tagNames'
import { AXIS_NAMES, type AxisEnd, type AxisEntry, type AxisName } from './types'

const THUMB = 128

const AXIS_TITLE = { x: 'stylemap.axes.x', y: 'stylemap.axes.y', z: 'stylemap.axes.z' } as const

/**
 * "What the axes mean": a card over the map with, for each axis, the
 * pictures at its two ends and the tags that set them apart (GET
 * /api/style-map/axes). A picture previews in the side panel and turns the
 * camera to its dot. Esc or × closes it. (The next stage adds a "my axes"
 * tab here: axes the user defines with example pictures.)
 */
export function AxesPanel() {
  const t = useT()
  const axes = useMap((s) => s.axes)
  const [active, setActive] = useState<number | null>(null)
  const close = () => setAxesOpen(false)
  useLayer(true, close)

  const pick = (id: number) => {
    setActive(id)
    setPreview({ id, members: 1 })
    const scene = getScene()
    const at = scene?.positionOf(id)
    if (scene && at) scene.flyTo(at, { exact: true })
  }

  let body
  if (axes.state === 'ok' && axes.data?.axes) {
    const data = axes.data.axes
    body = AXIS_NAMES.map((axis) => <AxisBlock key={axis} axis={axis} entry={data[axis]} active={active} onPick={pick} />)
  } else if (axes.state === 'error') {
    body = (
      <div className={styles.axesState}>
        <span>{t('stylemap.axes.error')}</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={retryAxes} data-testid="stylemap-axes-retry">
          {t('stylemap.axes.retry')}
        </button>
      </div>
    )
  } else {
    body = <div className={styles.axesState}>{t(axes.state === 'loading' ? 'stylemap.axes.loading' : 'stylemap.axes.idle')}</div>
  }

  return (
    <section className={styles.axesPanel} id="stylemap-axes-panel" aria-labelledby="stylemap-axes-title" data-testid="stylemap-axes-panel">
      <header className={styles.axesHead}>
        <h2 className={styles.axesTitle} id="stylemap-axes-title">
          {t('stylemap.axes.title')}
        </h2>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={close} aria-label={t('stylemap.axes.closeLabel')} title={t('stylemap.axes.closeLabel')} data-testid="stylemap-axes-close">
          <Icon name="close" size={13} />
        </button>
      </header>
      <p className={styles.axesNote} data-umap={axes.layout === 'umap' || undefined}>
        {t(axes.layout === 'umap' ? 'stylemap.axes.umapNote' : 'stylemap.axes.note')}
      </p>
      <div className={styles.axesBody}>{body}</div>
    </section>
  )
}

function AxisBlock({ axis, entry, active, onPick }: { axis: AxisName; entry: AxisEntry | undefined; active: number | null; onPick: (id: number) => void }) {
  const t = useT()
  return (
    <div className={styles.axis} data-axis={axis} data-weak={entry?.weak || undefined}>
      <div className={styles.axisName}>{t(AXIS_TITLE[axis])}</div>
      <div className={styles.ends}>
        <EndBlock label={t('stylemap.axes.low')} end={entry?.low} active={active} onPick={onPick} />
        <EndBlock label={t('stylemap.axes.high')} end={entry?.high} active={active} onPick={onPick} />
      </div>
      {entry?.weak && <div className={styles.axisWeak}>{t('stylemap.axes.weak')}</div>}
    </div>
  )
}

function EndBlock({ label, end, active, onPick }: { label: string; end: AxisEnd | undefined; active: number | null; onPick: (id: number) => void }) {
  const t = useT()
  const tags = (end?.tags ?? []).map((x) => tagName(t, x.tag))
  return (
    <div className={styles.end}>
      <div className={styles.endName}>{label}</div>
      <div className={styles.endThumbs}>
        {(end?.representatives ?? []).map((id) => (
          <button
            key={id}
            type="button"
            className={styles.endThumb}
            aria-current={active === id || undefined}
            title={t('stylemap.axes.pickTip')}
            onClick={() => onPick(id)}
            data-testid="stylemap-axes-thumb"
          >
            <img src={thumbnailUrl(id, THUMB)} alt="" decoding="async" />
          </button>
        ))}
      </div>
      {tags.length > 0 && <div className={styles.endTags}>{tags.join(' · ')}</div>}
    </div>
  )
}
