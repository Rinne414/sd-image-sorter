import { useState } from 'react'
import { useT } from '../../i18n'
import styles from './Card.module.css'

interface Props {
  value: number
  onChange: (stars: number) => void
  size?: 'sm' | 'md'
}

/** Five stars; clicking the current value clears it. Keys 1-5 / 0 do the same elsewhere. */
export function Stars({ value, onChange, size = 'md' }: Props) {
  const t = useT()
  const [hover, setHover] = useState(0)
  const shown = hover || value
  return (
    <span className={styles.stars} data-size={size} onMouseLeave={() => setHover(0)} role="radiogroup">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          className={styles.star}
          data-on={n <= shown || undefined}
          title={value === n ? t('card.clearStars') : t('card.stars', { n })}
          onMouseEnter={() => setHover(n)}
          onClick={() => onChange(value === n ? 0 : n)}
        >
          ★
        </button>
      ))}
    </span>
  )
}
