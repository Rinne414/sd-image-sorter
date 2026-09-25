import { useMemo } from 'react'
import type { TagCategory } from '../../api/types'
import { segmentPrompt, type Segment } from '../../lib/prompt'
import styles from './Card.module.css'

interface Props {
  text: string
  categories: Map<string, TagCategory> | undefined
}

function categoryOf(seg: Segment, categories: Map<string, TagCategory> | undefined): TagCategory {
  if (seg.forcedCategory) return seg.forcedCategory
  return (seg.key && categories?.get(seg.key)) || 'unknown'
}

/** A prompt with its syntax dimmed and every tag in its category colour. */
export function PromptText({ text, categories }: Props) {
  const segments = useMemo(() => segmentPrompt(text), [text])
  return (
    <p className={styles.prompt}>
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case 'tag':
            return (
              <span key={i} className={`${styles.ptag} cat-${categoryOf(seg, categories)}`}>
                {seg.text}
              </span>
            )
          case 'weight':
            return (
              <span key={i} className={styles.pweight}>
                {seg.text}
              </span>
            )
          case 'lora':
            return (
              <span key={i} className={styles.plora}>
                {seg.text}
              </span>
            )
          case 'keyword':
            return (
              <span key={i} className={styles.pkeyword}>
                {seg.text}
              </span>
            )
          case 'newline':
            return <br key={i} />
          case 'punct':
            return (
              <span key={i} className={seg.text === ',' ? styles.pcomma : styles.ppunct}>
                {seg.text}
              </span>
            )
          default:
            return seg.text
        }
      })}
    </p>
  )
}
