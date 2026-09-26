import { useEffect, useId, useState } from 'react'
import { useT } from '../../i18n'
import { usesThreshold } from './searchRequest'
import { useScopeCollections } from './similarApi'
import { useSimilar, type SimilarQuery } from './similarStore'
import styles from './Similar.module.css'

/** A dragged threshold is searched once it rests this long. */
const SETTLE_MS = 300

/** In the similarity banner: the threshold (where it applies) and where to search, as in V3.5's panel. */
export function SearchTools({ query }: { query: SimilarQuery }) {
  return (
    <div className={styles.tools}>
      {usesThreshold(query) && <Threshold />}
      <Scope />
    </div>
  )
}

function Threshold() {
  const t = useT()
  const id = useId()
  const saved = useSimilar((s) => s.options.threshold)
  const [value, setValue] = useState(saved)
  useEffect(() => setValue(saved), [saved])
  useEffect(() => {
    if (value === saved) return
    const timer = window.setTimeout(() => useSimilar.getState().setOptions({ threshold: value }), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [value, saved])
  const shown = `${Math.round(value * 100)}%`
  return (
    <span className={styles.tool}>
      <label htmlFor={id}>{t('sim.threshold')}</label>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        aria-valuetext={shown}
        title={t('sim.thresholdHint')}
        data-testid="similar-threshold"
      />
      <span className={`${styles.toolValue} mono`}>{shown}</span>
    </span>
  )
}

function Scope() {
  const t = useT()
  const id = useId()
  const collectionId = useSimilar((s) => s.options.collectionId)
  const collections = useScopeCollections().data ?? []
  const favorites = collections.find((c) => c.slug === 'favorites')
  const others = collections.filter((c) => c.slug !== 'favorites')
  return (
    <span className={styles.tool}>
      <label htmlFor={id}>{t('sim.scope')}</label>
      <select
        id={id}
        className={styles.select}
        value={collectionId ?? ''}
        onChange={(e) => useSimilar.getState().setOptions({ collectionId: e.target.value ? Number(e.target.value) : null })}
        data-testid="similar-scope"
      >
        <option value="">{t('sim.scope.library')}</option>
        {favorites && <option value={favorites.id}>{t('sim.scope.favorites')}</option>}
        {others.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </span>
  )
}
