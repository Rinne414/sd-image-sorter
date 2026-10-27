import { useState } from 'react'
import { thumbnailUrl } from '../../api/urls'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { useLayer } from '../../ui/layers'
import { AXIS_TITLE } from './customAxes'
import { CustomAxesTab } from './CustomAxesTab'
import { setAxesTab, useCustom, useCustomShown, type AxesTab } from './customStore'
import { retryAxes, setAxesOpen, setPreview, useMap } from './mapStore'
import styles from './MapCanvas.module.css'
import { getScene } from './sceneHandle'
import { tagName } from './tagNames'
import { AXIS_NAMES, type AxisEnd, type AxisEntry, type AxisName } from './types'

const THUMB = 128

const TABS: readonly { id: AxesTab; label: 'stylemap.axes.tabModel' | 'stylemap.axes.tabCustom' }[] = [
  { id: 'model', label: 'stylemap.axes.tabModel' },
  { id: 'custom', label: 'stylemap.axes.tabCustom' },
]

/**
 * "What the axes mean": a card over the map with two tabs. The model's axes:
 * for each axis, the pictures at its two ends and the tags that set them
 * apart (GET /api/style-map/axes); a picture previews in the side panel and
 * turns the camera to its dot. My axes: the user defines an axis by example
 * pictures and the map is laid out along it (CustomAxesTab.tsx). Esc or ×
 * closes the card.
 */
export function AxesPanel() {
  const t = useT()
  const tab = useCustom((s) => s.tab)
  const close = () => setAxesOpen(false)
  useLayer(true, close)

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
      <div className={styles.axesTabs} role="tablist" aria-label={t('stylemap.axes.title')}>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`stylemap-axes-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="stylemap-axes-tabpanel"
            className={styles.axesTab}
            onClick={() => setAxesTab(item.id)}
            data-testid={`stylemap-axes-tab-${item.id}`}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <div className={styles.axesTabPanel} role="tabpanel" id="stylemap-axes-tabpanel" aria-labelledby={`stylemap-axes-tab-${tab}`}>
        {tab === 'custom' ? <CustomAxesTab /> : <ModelAxes />}
      </div>
    </section>
  )
}

function ModelAxes() {
  const t = useT()
  const axes = useMap((s) => s.axes)
  const custom = useCustomShown()
  const [active, setActive] = useState<number | null>(null)

  const pick = (id: number) => {
    setActive(id)
    setPreview({ id, members: 1 })
    const scene = getScene()
    const at = scene?.positionOf(id)
    if (scene && at) scene.flyTo(at, { exact: true })
  }

  // The model's meanings describe its own layout: hidden while the user's axes place the dots.
  if (custom) {
    return (
      <div className={styles.axesBody}>
        <div className={styles.axesState} data-testid="stylemap-axes-hidden">
          {t('stylemap.custom.hiddenModel')}
        </div>
      </div>
    )
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
    <>
      <p className={styles.axesNote} data-umap={axes.layout === 'umap' || undefined}>
        {t(axes.layout === 'umap' ? 'stylemap.axes.umapNote' : 'stylemap.axes.note')}
      </p>
      <div className={styles.axesBody}>{body}</div>
    </>
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
