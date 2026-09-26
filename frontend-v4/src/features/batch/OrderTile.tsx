import type { DragEvent, MouseEvent, PointerEvent } from 'react'
import type { Batch } from '../../api/types'
import { useT } from '../../i18n'
import { formatScore } from '../../lib/imageInfo'
import { entryThumb, type Entry } from './entries'
import { ItemBadges, ItemImage } from './ItemImage'
import styles from './OrderStep.module.css'

interface Props {
  batch: Batch
  entry: Entry
  /** Its place in the grid as shown (the name filter may hide others). */
  index: number
  /** Its place in the posting order, from 0. */
  position: number
  cursor: boolean
  selected: boolean
  /** A condition is set and this image does not match it. */
  dim: boolean
  dragging: boolean
  drop: 'before' | 'after' | undefined
  /** Its aesthetic score, when it has one. */
  score: number | undefined
  onClick: (index: number, e: MouseEvent) => void
  onHover: (entry: Entry, e: PointerEvent) => void
  onLeave: () => void
  onDragStart: (index: number, e: DragEvent<HTMLDivElement>) => void
  onDragOver: (index: number, e: DragEvent<HTMLDivElement>) => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}

/** One picture of the posting order, large, with its number. */
export function OrderTile(p: Props) {
  const t = useT()
  const { entry } = p
  const score = formatScore(p.score)
  return (
    <div
      className={styles.tile}
      role="option"
      aria-selected={p.selected || p.cursor}
      data-index={p.index}
      data-cursor={p.cursor || undefined}
      data-selected={p.selected || undefined}
      data-dim={p.dim || undefined}
      data-dragging={p.dragging || undefined}
      data-drop={p.drop}
      data-testid="order-tile"
      data-id={entry.imageId ?? undefined}
      data-key={entry.key}
      title={entry.filename}
      draggable
      onClick={(e) => p.onClick(p.index, e)}
      onPointerEnter={(e) => p.onHover(entry, e)}
      onPointerLeave={p.onLeave}
      onDragStart={(e) => p.onDragStart(p.index, e)}
      onDragOver={(e) => p.onDragOver(p.index, e)}
      onDrop={p.onDrop}
      onDragEnd={p.onDragEnd}
    >
      <div className={styles.frame}>
        <EntryImage batch={p.batch} entry={entry} />
        <span className={`${styles.number} mono`} data-testid="order-number">
          {p.position + 1}
        </span>
        {score && (
          <span className={`${styles.score} mono`} data-testid="order-aesthetic">
            {t('info.aes.edge', { score })}
          </span>
        )}
      </div>
      <div className={styles.meta}>
        <span className={`${styles.caption} mono`}>{entry.filename}</span>
        {entry.item && <ItemBadges item={entry.item} />}
      </div>
    </div>
  )
}

/** A Pixiv or custom item as it will be posted (censored copy); a dataset image as it is. */
function EntryImage({ batch, entry }: { batch: Batch; entry: Entry }) {
  if (entry.item) return <ItemImage batch={batch} item={entry.item} size={512} />
  const src = entryThumb(entry, 512)
  return <div className={styles.plain}>{src && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />}</div>
}
