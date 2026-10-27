import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useTheme } from '../../theme'
import { withClip } from '../similar/clip'
import { startIndexing } from '../similar/similarApi'
import { useJobs } from '../jobs/jobs'
import { AxesPanel } from './AxesPanel'
import { AxisLabels } from './AxisLabels'
import { buildPointColors } from './colors'
import { cloudArrays } from './geometry'
import { indexRunning, startStyleIndex } from './indexJob'
import { Landmarks } from './Landmarks'
import styles from './MapCanvas.module.css'
import { openPicture } from './MapLightbox'
import { mapOnScreen, setPreview, useMap } from './mapStore'
import { ringsNow, useNear } from './nearStore'
import { StyleMapScene } from './scene'
import { emitCamera, setScene } from './sceneHandle'
import { hasPoints, startCard } from './status'

/**
 * The 3-D view: drag to rotate, wheel to zoom, right-drag (or the arrow keys)
 * to pan. Pointing at a dot previews its picture; a click opens it. Over the
 * canvas: the landmarks, the axis labels, the axis card, the start card when
 * there is nothing to draw, and "Reset view".
 */
export function MapCanvas() {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [scene, setSceneState] = useState<StyleMapScene | null>(null)
  const [unsupported, setUnsupported] = useState<string | null>(null)
  const points = useMap((s) => s.points)
  const colors = useMap((s) => s.colors)
  const loading = useMap((s) => s.loading)
  const axesOpen = useMap((s) => s.axesOpen)
  const theme = useTheme((s) => s.theme)
  const near = useNear()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let made: StyleMapScene
    try {
      made = new StyleMapScene(canvas, {
        onHover: (hit) => setPreview(hit),
        onCameraChange: emitCamera,
        onClickDot: (hit) => void openPicture(hit.id, hit.members),
      })
    } catch (error) {
      // No WebGL (an old driver, hardware acceleration off, a remote desktop): say so once.
      setUnsupported((error as Error).message || String(error))
      return
    }
    setScene(made)
    setSceneState(made)
    made.resume()
    return () => {
      setScene(null)
      made.dispose()
    }
  }, [])

  // Effects run in this order on one render: the dots, then their colours, then the rings.
  useEffect(() => {
    if (!scene) return
    const rows = points?.status === 'ok' ? (points.points ?? []) : []
    scene.setPoints(cloudArrays(rows, points?.points_layout))
  }, [scene, points])

  useEffect(() => {
    scene?.setBaseColors(colors ? buildPointColors(colors, scene.ids) : null)
  }, [scene, points, colors])

  useEffect(() => {
    scene?.setRings(ringsNow(near, mapOnScreen()?.signature ?? null))
  }, [scene, points, near])

  useEffect(() => {
    scene?.applyTheme()
  }, [scene, theme])

  const drawn = hasPoints(points)
  return (
    <div className={styles.card} data-testid="stylemap-canvas-card">
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        tabIndex={0}
        aria-label={t('stylemap.view.mapLabel')}
        data-testid="stylemap-canvas"
      />
      {scene && drawn && <AxisLabels scene={scene} />}
      {scene && drawn && <Landmarks scene={scene} />}
      {loading && <span className={styles.loading}>{t('stylemap.loading')}</span>}
      {unsupported ? <Unsupported detail={unsupported} /> : <StartCard />}
      {scene && drawn && (
        <button type="button" className={`btn btn-sm ${styles.reset}`} onClick={() => scene.resetView()} data-testid="stylemap-reset-view">
          {t('stylemap.view.reset')}
        </button>
      )}
      {axesOpen && <AxesPanel />}
    </div>
  )
}

/** Nothing to draw yet: what is missing and the one button that fills it. */
function StartCard() {
  const t = useT()
  const points = useMap((s) => s.points)
  const space = useMap((s) => s.space)
  const token = useMap((s) => s.token)
  const running = useJobs((s) => indexRunning(s.jobs) || (space === 'clip' && s.jobs.some((j) => j.kind === 'embed' && j.progress.status === 'running')))
  const card = startCard(points, space, running)
  if (!card) return null
  return (
    <div className={styles.start} data-testid="stylemap-empty">
      <span className={styles.eyebrow}>{t(card.eyebrow)}</span>
      <h2 className={styles.startTitle}>{t(card.title)}</h2>
      <p className={styles.startText}>{t(card.text)}</p>
      {card.action === 'build' && (
        <button type="button" className="btn btn-primary" onClick={() => void startStyleIndex(space, token)} data-testid="stylemap-empty-build">
          {t(space === 'csd' ? 'stylemap.index.buildCsd' : 'stylemap.index.build')}
        </button>
      )}
      {card.action === 'buildClip' && (
        <button type="button" className="btn btn-primary" onClick={() => void withClip(() => void startIndexing())} data-testid="stylemap-empty-similar">
          {t('stylemap.index.buildClip')}
        </button>
      )}
    </div>
  )
}

function Unsupported({ detail }: { detail: string }) {
  const t = useT()
  return (
    <div className={styles.start} data-testid="stylemap-unsupported">
      <h2 className={styles.startTitle}>{t('stylemap.webgl.title')}</h2>
      <p className={styles.startText}>{t('stylemap.webgl.text')}</p>
      {detail && <p className={styles.startDetail}>{detail}</p>}
    </div>
  )
}
