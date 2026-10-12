import { useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { imageFileUrl, thumbnailUrl } from '../../api/client'
import { useT, type MessageKey } from '../../i18n'
import { compare, facts, heldRounds, spotOnPicture, zoomOrigin, ZOOM_SCALE, type DiffKey, type FactKey } from './sortModes'
import type { Duel, SessionView, SortImage } from './sortSession'
import styles from './SortStage.module.css'
import { useSort } from './sortStore'
import { Stage, useLit } from './StageParts'

type Translate = ReturnType<typeof useT>
type Spot = { x: number; y: number }

const PARAM: Record<DiffKey, MessageKey> = {
  sampler: 'sort.param.sampler',
  cfg: 'sort.param.cfg',
  steps: 'sort.param.steps',
  seed: 'sort.param.seed',
  scheduler: 'sort.param.scheduler',
  denoise: 'sort.param.denoise',
  model: 'sort.param.model',
  size: 'sort.param.size',
}

export function factText(t: Translate, key: FactKey, value: string): string {
  if (key === 'cfg') return `CFG ${value}`
  if (key === 'seed') return `SEED ${value}`
  if (key === 'steps') return t('sort.fact.steps', { n: value })
  if (key === 'aesthetic') return t('sort.fact.aesthetic', { n: value })
  return value
}

/** The A/B showdown in progress: two pictures side by side, only their differences, three keys. */
export function DuelStage({ view }: { view: SessionView }) {
  const t = useT()
  const [zoom, setZoom] = useState(false)
  const [spot, setSpot] = useState<Spot | null>(null)
  const lit = useLit((last) => (last.kind === 'pick' ? last.side : last.kind === 'skip' ? 'skip' : null))
  const duel = view.duel
  const press = useSort((s) => s.press)

  const keys = (
    <div className={styles.choices}>
      <button type="button" className={styles.choice} data-lit={lit === 'a' || undefined} onClick={() => press({ kind: 'pick', side: 'a' })} data-testid="sort-pick-a">
        <kbd className={styles.cap}>←</kbd>
        <span className={styles.slotName}>{t('sort.ab.keepA')}</span>
        <span className={`${styles.keysAlso} mono`}>A</span>
      </button>
      <button type="button" className={styles.choice} data-lit={lit === 'skip' || undefined} onClick={() => press({ kind: 'skip' })} data-testid="sort-skip">
        <kbd className={styles.cap}>{t('sort.spaceKey')}</kbd>
        <span className={styles.slotName}>{t('sort.ab.skip')}</span>
        <span className={`${styles.slotCount} mono`}>{view.skipped}</span>
      </button>
      <button type="button" className={styles.choice} data-lit={lit === 'b' || undefined} onClick={() => press({ kind: 'pick', side: 'b' })} data-testid="sort-pick-b">
        <kbd className={styles.cap}>→</kbd>
        <span className={styles.slotName}>{t('sort.ab.takeB')}</span>
        <span className={`${styles.keysAlso} mono`}>D</span>
      </button>
      <button type="button" className={`btn ${styles.zoomToggle}`} aria-pressed={zoom} title={t('sort.ab.zoomHint')} onClick={() => setZoom(!zoom)} data-testid="sort-zoom">
        {t('sort.ab.zoom')}
      </button>
    </div>
  )
  return (
    <Stage view={view} image={duel?.b ?? null} infoId={null} keys={keys}>
      {duel && (
        <div className={styles.duel} data-testid="sort-duel">
          <DuelSide duel={duel} side="a" zoom={zoom} spot={spot} onSpot={setSpot} />
          <DuelSide duel={duel} side="b" zoom={zoom} spot={spot} onSpot={setSpot} />
          <DiffStrip a={duel.a} b={duel.b} />
        </div>
      )}
    </Stage>
  )
}

interface SideProps {
  duel: Duel
  side: 'a' | 'b'
  zoom: boolean
  spot: Spot | null
  onSpot: (spot: Spot | null) => void
}

/** One side of the pair: its label, the picture (click it to choose it), its settings. */
function DuelSide({ duel, side, zoom, spot, onSpot }: SideProps) {
  const t = useT()
  const image = side === 'a' ? duel.a : duel.b
  const held = heldRounds(duel)
  return (
    <figure className={styles.side} data-side={side} data-testid={`sort-side-${side}`} data-id={image.id}>
      <figcaption className={styles.sideHead}>
        <strong>{t(side === 'a' ? 'sort.ab.a' : 'sort.ab.b')}</strong>
        {side === 'a' && held > 0 && <span className={styles.held}>{t('sort.ab.held', { n: held })}</span>}
        <span className={styles.sideName} title={image.path}>
          {image.filename}
        </span>
      </figcaption>
      <ZoomPicture key={image.id} image={image} side={side} zoom={zoom} spot={spot} onSpot={onSpot} />
      <p className={styles.facts}>
        {facts(image).map(([key, value]) => (
          <span key={key} className={`${styles.fact} mono`}>
            {factText(t, key, value)}
          </span>
        ))}
      </p>
    </figure>
  )
}

interface ZoomProps {
  image: SortImage
  side: 'a' | 'b'
  zoom: boolean
  spot: Spot | null
  onSpot: (spot: Spot | null) => void
}

/** A picture that, with "zoom both" on, magnifies the spot under the pointer, on either side. */
function ZoomPicture({ image, side, zoom, spot, onSpot }: ZoomProps) {
  const box = useRef<HTMLButtonElement>(null)
  const full = useRef<HTMLImageElement>(null)
  const [ready, setReady] = useState(false)
  const natural = () => ({ w: full.current?.naturalWidth ?? 0, h: full.current?.naturalHeight ?? 0 })

  const move = (e: MouseEvent) => {
    if (!zoom || !box.current) return
    const r = box.current.getBoundingClientRect()
    const { w, h } = natural()
    onSpot(spotOnPicture(w, h, r.width, r.height, e.clientX - r.left, e.clientY - r.top))
  }
  let style: CSSProperties | undefined
  if (zoom && spot && box.current) {
    const r = box.current.getBoundingClientRect()
    const { w, h } = natural()
    const o = zoomOrigin(spot, w, h, r.width, r.height)
    style = { transformOrigin: `${o.x}% ${o.y}%`, transform: `scale(${ZOOM_SCALE})` }
  }
  return (
    <button
      ref={box}
      type="button"
      className={styles.sidePicture}
      data-zoom={zoom || undefined}
      onMouseMove={move}
      onMouseLeave={() => onSpot(null)}
      onClick={() => useSort.getState().press({ kind: 'pick', side })}
      aria-label={image.filename}
    >
      <span className={styles.zoomLayer} style={style}>
        <img className={styles.under} src={thumbnailUrl(image.id, 384)} alt="" draggable={false} />
        <img ref={full} className={styles.full} data-ready={ready || undefined} src={imageFileUrl(image.id)} alt="" draggable={false} onLoad={() => setReady(true)} />
      </span>
    </button>
  )
}

/** Only what differs between A and B; what is the same, named once. */
function DiffStrip({ a, b }: { a: SortImage; b: SortImage }) {
  const t = useT()
  const { diffs, same, noParams } = compare(a.gen, b.gen)
  return (
    <p className={styles.diff} data-testid="sort-diff">
      <span className={styles.diffLabel}>{t('sort.ab.diff')}</span>
      {diffs.map((d) => (
        <span key={d.key} className={`${styles.diffChip} mono`}>
          <b>{t(PARAM[d.key])}</b> {d.a} <span aria-hidden>→</span> {d.b}
        </span>
      ))}
      {diffs.length === 0 && <span className={styles.diffNone}>{t(noParams ? 'sort.ab.noParams' : 'sort.ab.sameAll')}</span>}
      {same.length > 0 && <span className={styles.diffSame}>{t('sort.ab.same', { keys: same.map((k) => t(PARAM[k])).join(' · ') })}</span>}
    </p>
  )
}
