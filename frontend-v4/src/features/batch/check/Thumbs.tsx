import { useState } from 'react'
import { useT } from '../../../i18n'
import { entryThumb, type Entry } from '../entries'
import styles from './CheckStep.module.css'

/** Pictures shown before "+N" (a display choice; the rest show on request). */
const SHOWN = 14

interface Props {
  keys: readonly string[]
  entries: ReadonlyMap<string, Entry>
  notes?: Readonly<Record<string, string>>
  /** Opens the image in the caption editor; absent when it has no caption to edit. */
  onOpen?: (key: string) => void
  /** A duplicate group: the first one stays. */
  firstKept?: boolean
}

/** The images an issue is about, each with its fact (a size, a score) or its name. */
export function Thumbs({ keys, entries, notes, onOpen, firstKept }: Props) {
  const t = useT()
  const [all, setAll] = useState(false)
  const shown = all ? keys : keys.slice(0, SHOWN)
  return (
    <div className={styles.thumbs} data-testid="check-thumbs">
      {shown.map((key, i) => {
        const entry = entries.get(key)
        if (!entry) return null
        const src = entryThumb(entry, 160)
        const note = notes?.[key]
        const title = note ? `${entry.filename} · ${note}` : entry.filename
        const inner = (
          <>
            <span className={styles.pic}>
              {src ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} /> : <span className={styles.noPic}>{t('dataset.fileGone')}</span>}
              {firstKept && i === 0 && <span className={styles.kept}>{t('dataset.check.kept')}</span>}
            </span>
            <span className={`${styles.thumbNote} mono`}>{note ?? entry.filename}</span>
          </>
        )
        return onOpen ? (
          <button key={key} type="button" className={styles.thumb} title={title} onClick={() => onOpen(key)} data-testid="check-thumb" data-key={key}>
            {inner}
          </button>
        ) : (
          <div key={key} className={styles.thumb} title={title} data-testid="check-thumb" data-key={key}>
            {inner}
          </div>
        )
      })}
      {keys.length > shown.length && (
        <button type="button" className={styles.more} onClick={() => setAll(true)} title={t('dataset.check.showAll', { n: keys.length })}>
          +{(keys.length - shown.length).toLocaleString()}
        </button>
      )}
    </div>
  )
}
