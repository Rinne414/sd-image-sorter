import { useMutation, useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import { api, thumbnailUrl, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import type { ImageDetail } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { copyAndSay } from '../library/fileActions'
import { histogramPath } from '../censor/histogram'
import { createRaster } from '../censor/raster'
import cardStyles from '../card/Card.module.css'
import { binsPeak, channelBins, histogramLine, readColorFacts, type Bins, type ColorFacts, type HistMode } from './colors'
import styles from './ColorSection.module.css'

// "Colours" on the generation card: the histogram of the image (measured from
// its thumbnail) and its stored colour analysis, the data the colour filters
// and sorts use. An image without the analysis offers to analyse it.

/** Open or closed, and the histogram view, stay put while stepping through images. */
const useColorPrefs = create<{ open: boolean; mode: HistMode }>(() => ({ open: false, mode: 'rgb' }))

const SAMPLE = 128
const W = 256
const H = 64

async function loadBins(id: number): Promise<Bins> {
  const img = new Image()
  img.decoding = 'async'
  img.src = thumbnailUrl(id, 384)
  await img.decode()
  const scale = Math.min(1, SAMPLE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2d canvas')
  ctx.drawImage(img, 0, 0, w, h)
  return channelBins(createRaster(w, h, ctx.getImageData(0, 0, w, h).data))
}

export function ColorSection({ id, image }: { id: number; image: ImageDetail }) {
  const t = useT()
  const open = useColorPrefs((s) => s.open)
  return (
    <details className={cardStyles.extra} open={open} onToggle={(e) => useColorPrefs.setState({ open: e.currentTarget.open })} data-testid="card-colors">
      <summary>{t('info.color.title')}</summary>
      {open && <ColorBody id={id} image={image} />}
    </details>
  )
}

const MODES: [HistMode, MessageKey][] = [
  ['rgb', 'info.color.rgb'],
  ['split', 'info.color.split'],
  ['luma', 'info.color.luma'],
]

function ColorBody({ id, image }: { id: number; image: ImageDetail }) {
  const t = useT()
  const mode = useColorPrefs((s) => s.mode)
  const bins = useQuery({ queryKey: ['thumb-bins', id], queryFn: () => loadBins(id), staleTime: Infinity, retry: false })
  const facts = readColorFacts(image)
  return (
    <div className={styles.body}>
      <div className={styles.modes} role="group" aria-label={t('info.color.modes')}>
        {MODES.map(([m, key]) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => useColorPrefs.setState({ mode: m })}>
            {t(key)}
          </button>
        ))}
      </div>
      {bins.data ? (
        <Histogram bins={bins.data} mode={mode} />
      ) : bins.isError ? (
        <p className={cardStyles.muted}>{t('info.color.pixelsFailed')}</p>
      ) : (
        <div className={styles.histogram} aria-hidden />
      )}
      {facts ? <Facts facts={facts} /> : <Unanalysed id={id} />}
    </div>
  )
}

function Histogram({ bins, mode }: { bins: Bins; mode: HistMode }) {
  const peak = binsPeak(bins, mode)
  return (
    <svg className={styles.histogram} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" data-testid="card-histogram" data-mode={mode} aria-hidden>
      {mode === 'luma' && <path className={styles.luma} d={histogramPath(bins.l, peak, W, H)} />}
      {mode === 'rgb' && (
        <>
          <path className={styles.lumaFaint} d={histogramPath(bins.l, peak, W, H)} />
          <path className={styles.b} d={histogramPath(bins.b, peak, W, H)} />
          <path className={styles.g} d={histogramPath(bins.g, peak, W, H)} />
          <path className={styles.r} d={histogramPath(bins.r, peak, W, H)} />
        </>
      )}
      {mode === 'split' && (
        <>
          <path className={styles.lineR} d={histogramLine(bins.r, peak, W, 0, H / 3)} />
          <path className={styles.lineG} d={histogramLine(bins.g, peak, W, H / 3, H / 3)} />
          <path className={styles.lineB} d={histogramLine(bins.b, peak, W, (2 * H) / 3, H / 3)} />
        </>
      )}
    </svg>
  )
}

const TEMPERATURE: Record<NonNullable<ColorFacts['temperature']>, MessageKey> = {
  warm: 'info.color.temp.warm',
  cool: 'info.color.temp.cool',
  neutral: 'info.color.temp.neutral',
}

function Facts({ facts }: { facts: ColorFacts }) {
  const t = useT()
  const stats = [
    facts.brightness !== null ? t('info.color.brightness', { n: facts.brightness }) : null,
    facts.saturation !== null ? t('info.color.saturation', { n: facts.saturation }) : null,
    facts.temperature ? t(TEMPERATURE[facts.temperature]) : null,
    facts.distribution ? t(`info.color.dist.${facts.distribution}` as MessageKey) : null,
  ].filter((s): s is string => !!s)
  return (
    <>
      {facts.colors.length > 0 && (
        <div className={styles.swatches} aria-label={t('info.color.main')} data-testid="card-swatches">
          {facts.colors.map((c) => (
            <button key={c.hex} type="button" className={styles.swatch} onClick={() => void copyAndSay(c.hex, { text: c.hex })} title={t('info.color.copyHex', { hex: c.hex })}>
              {/* The picture's own colour: data, not a design colour. */}
              <span className={styles.dot} style={{ background: c.hex }} />
              <span className="mono">{c.hex}</span>
              <span className={`${styles.pct} mono`}>{Math.round(c.pct)}%</span>
            </button>
          ))}
        </div>
      )}
      <p className={styles.stats}>{stats.join(' · ')}</p>
    </>
  )
}

/** No stored analysis: say what that costs and analyse this one image on the spot. */
function Unanalysed({ id }: { id: number }) {
  const t = useT()
  const analyse = useMutation({
    mutationFn: async () => unwrap(await api.POST('/api/colors/analyze-single/{image_id}', { params: { path: { image_id: id } } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['image', id] })
      void queryClient.invalidateQueries({ queryKey: ['colors-missing'] })
    },
    onError: (error) => useToasts.getState().push(t('info.color.failed', { reason: error.message }), 'error'),
  })
  return (
    <div className={styles.unanalysed} data-testid="card-colors-missing">
      <p className={cardStyles.muted}>{t('info.color.none')}</p>
      <button type="button" className="btn" onClick={() => analyse.mutate()} disabled={analyse.isPending} data-testid="card-colors-analyse">
        {analyse.isPending ? t('info.color.analysing') : t('info.color.analyse')}
      </button>
    </div>
  )
}
