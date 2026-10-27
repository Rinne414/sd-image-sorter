import { useLayoutEffect, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { useClickOutside, useLayer } from '../../ui/layers'
import { generatorName } from '../../lib/format'
import { foldChips, formatScore, legendHex, NO_DATA_HEX, OTHER_KEY, RAMP_CSS } from './colors'
import { retryColors, useMap } from './mapStore'
import styles from './StyleMap.module.css'
import type { ColorsAnswer, LegendEntry } from './types'

const CHIP_GAP = 6
const MIN_SQUEEZED_CHIP = 72

interface Chip {
  key: string
  label: string
  count: number
  color: string
  title: string
}

function chipsOf(body: ColorsAnswer, label: (entry: LegendEntry) => string, t: (key: MessageKey, params?: Record<string, string | number>) => string): Chip[] {
  const chips: Chip[] = (body.legend ?? []).map((entry, index) => {
    const pictures = t('stylemap.legend.pictures', { n: entry.count })
    return {
      key: entry.key,
      label: entry.key === OTHER_KEY ? t('stylemap.legend.other') : label(entry),
      count: entry.count,
      color: legendHex(entry, index),
      title: entry.key === OTHER_KEY ? pictures : `${entry.key}\n${pictures}`,
    }
  })
  if ((body.missing ?? 0) > 0) {
    const n = body.missing ?? 0
    chips.push({ key: '', label: t('stylemap.legend.noData'), count: n, color: NO_DATA_HEX, title: t('stylemap.legend.pictures', { n }) })
  }
  return chips
}

/**
 * The legend next to the colour field: one row of chips (categories) or the
 * score ramp with its two ends, plus "no data" when some dots have none.
 * Chips that do not fit fold into "+N", which opens the whole list.
 */
export function Legend() {
  const t = useT()
  const colors = useMap((s) => s.colors)
  const state = useMap((s) => s.colorsState)
  const hasMap = useMap((s) => s.points?.status === 'ok')
  const by = colors?.by
  const label = (entry: LegendEntry) => (by === 'generator' ? generatorName(entry.key, t) : entry.label || entry.key)

  if (!hasMap) return <div className={styles.legend} />
  if (!colors) {
    return (
      <div className={styles.legend} data-testid="stylemap-legend">
        {state === 'error' ? (
          <>
            <span className={styles.legendNote}>{t('stylemap.colors.error')}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={retryColors} data-testid="stylemap-colors-retry">
              {t('stylemap.colors.retry')}
            </button>
          </>
        ) : (
          <span className={styles.legendNote}>{t('stylemap.colors.loading')}</span>
        )}
      </div>
    )
  }
  if (colors.kind === 'scale') return <ScaleLegend colors={colors} />
  return <ChipRow chips={chipsOf(colors, label, t)} />
}

function ScaleLegend({ colors }: { colors: ColorsAnswer }) {
  const t = useT()
  const range = colors.range
  return (
    <div className={styles.legend} data-testid="stylemap-legend">
      {range ? (
        <span className={styles.scale}>
          <span className="mono">{formatScore(range[0])}</span>
          <span className={styles.ramp} style={{ backgroundImage: RAMP_CSS }} aria-hidden />
          <span className="mono">{formatScore(range[1])}</span>
        </span>
      ) : (
        <span className={styles.chip}>
          <span className={styles.swatch} style={{ background: NO_DATA_HEX }} aria-hidden />
          {t('stylemap.legend.noScores')}
        </span>
      )}
      {(colors.missing ?? 0) > 0 && range && (
        <span className={styles.chip} title={t('stylemap.legend.pictures', { n: colors.missing ?? 0 })}>
          <span className={styles.swatch} style={{ background: NO_DATA_HEX }} aria-hidden />
          <span className={styles.chipLabel}>{t('stylemap.legend.noData')}</span>
          <span className={styles.chipCount}>{colors.missing}</span>
        </span>
      )}
    </div>
  )
}

function ChipView({ chip, squeeze }: { chip: Chip; squeeze?: number | null }) {
  return (
    <span className={styles.chip} title={chip.title} data-key={chip.key || undefined} style={squeeze ? { maxWidth: squeeze } : undefined}>
      <span className={styles.swatch} style={{ background: chip.color }} aria-hidden />
      <span className={styles.chipLabel}>{chip.label}</span>
      <span className={styles.chipCount}>{chip.count}</span>
    </span>
  )
}

/** The chips that fit the row, then "+N" for the rest (as many as fit, never an empty row). */
function ChipRow({ chips }: { chips: Chip[] }) {
  const t = useT()
  const rowRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [fold, setFold] = useState<{ shown: number; squeeze: number | null }>({ shown: chips.length, squeeze: null })
  const [open, setOpen] = useState(false)
  useLayer(open, () => setOpen(false))
  useClickOutside(wrapRef, open, () => setOpen(false))

  useLayoutEffect(() => {
    const row = rowRef.current
    const measure = measureRef.current
    if (!row || !measure) return
    const refold = () => {
      const widths = [...measure.querySelectorAll<HTMLElement>('[data-measure="chip"]')].map((el) => el.offsetWidth)
      const button = measure.querySelector<HTMLElement>('[data-measure="more"]')?.offsetWidth ?? 48
      setFold(foldChips(widths, row.clientWidth, button, CHIP_GAP, MIN_SQUEEZED_CHIP))
      setOpen(false)
    }
    refold()
    const observer = new ResizeObserver(refold)
    observer.observe(row)
    return () => observer.disconnect()
  }, [chips])

  const hidden = chips.length - fold.shown
  return (
    <div className={styles.legendWrap} ref={wrapRef}>
      <div className={styles.legend} ref={rowRef} data-testid="stylemap-legend">
        {chips.slice(0, fold.shown).map((chip, i) => (
          <ChipView key={chip.key || 'nodata'} chip={chip} squeeze={i === 0 ? fold.squeeze : null} />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            className={styles.more}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            title={t('stylemap.legend.moreTitle', { n: chips.length })}
            data-testid="stylemap-legend-more"
          >
            {open ? t('stylemap.legend.less') : t('stylemap.legend.more', { n: hidden })}
          </button>
        )}
      </div>
      {/* Off screen: every chip at its natural width, and the button at its widest words. */}
      <div className={styles.measure} ref={measureRef} aria-hidden>
        {chips.map((chip) => (
          <span key={chip.key || 'nodata'} data-measure="chip">
            <ChipView chip={chip} />
          </span>
        ))}
        <span className={styles.more} data-measure="more">
          {t('stylemap.legend.less')}
        </span>
      </div>
      {open && (
        <div className={styles.legendPop} data-testid="stylemap-legend-pop">
          {chips.map((chip) => (
            <ChipView key={chip.key || 'nodata'} chip={chip} />
          ))}
        </div>
      )}
    </div>
  )
}
