import { useT, type MessageKey } from '../../../i18n'
import { copyText, generatorCode } from '../../../lib/format'
import { formatScore } from '../../../lib/imageInfo'
import type { GenerationInfo } from '../../../lib/meta'
import styles from '../Card.module.css'

// The film edge around a picture: the key parameters printed along its top
// and bottom, each copied by a click. The generation card and the Reader
// frame their pictures with it.

const RATING_KEYS: Record<string, MessageKey> = {
  general: 'rating.general',
  sensitive: 'rating.sensitive',
  questionable: 'rating.questionable',
  explicit: 'rating.explicit',
}

/** What the film edge prints: the key parameters, plus the img2img marker and the aesthetic score. */
export interface EdgeFacts {
  gen: GenerationInfo | null
  generator: string | null
  rating?: string | null
  score?: number | null
  /** The img2img marker's words, when the image was made from another. */
  i2i?: string | null
}

/** Parameters printed on the film edge; click a code to copy its value. */
export function EdgeCodes({ gen, generator, rating, score, i2i, part, inline }: EdgeFacts & { part?: 'top' | 'bottom'; inline?: boolean }) {
  const t = useT()
  // [label, what is shown, what gets copied]
  type Code = [string, string, string]
  const code = (label: string, value: string | null | undefined, shown?: string): Code | null =>
    value ? [label, shown ?? value, value] : null
  const ratingKey = rating && RATING_KEYS[rating]
  const top = [
    code('SEED', gen?.seed),
    code('', gen?.steps, gen?.steps ? t('edge.steps', { n: gen.steps }) : undefined),
    code('CFG', gen?.cfg),
    code('', gen?.denoise, gen?.denoise ? t('edge.denoise', { n: gen.denoise }) : undefined),
    code('', i2i),
  ]
  const shownScore = formatScore(score)
  const bottom = [
    code('', gen?.sampler),
    code('', gen?.scheduler),
    code('', gen?.size),
    code('', rating, ratingKey ? t(ratingKey) : undefined),
    code('', shownScore, shownScore ? t('info.aes.edge', { score: shownScore }) : undefined),
    code('', generatorCode(generator)),
  ]
  const rows = inline ? [...top, ...bottom] : part === 'top' ? top : bottom
  const shown = rows.filter((c): c is Code => c !== null)
  return (
    <div className={styles.edgeStrip} data-part={part} data-inline={inline || undefined}>
      {!inline && <span className={styles.holes} aria-hidden />}
      <span className={styles.codes}>
        {shown.map(([label, display, value]) => (
          <button
            key={`${label}${value}`}
            type="button"
            className={styles.code}
            title={t('card.clickToCopy')}
            onClick={() => void copyText(value)}
          >
            {label && <span className={styles.codeKey}>{label}</span>}
            {display.toUpperCase()}
          </button>
        ))}
      </span>
    </div>
  )
}
