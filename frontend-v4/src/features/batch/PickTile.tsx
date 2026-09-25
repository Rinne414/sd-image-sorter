import type { DragEvent, MouseEvent } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { entryThumb, type Entry } from './entries'
import styles from './PickStep.module.css'

export type DropSide = 'before' | 'after'

interface Props {
  entry: Entry
  index: number
  x: number
  y: number
  width: number
  cursor: boolean
  selected: boolean
  pending: boolean
  drop: DropSide | undefined
  dragging: boolean
  onClick: (index: number, e: MouseEvent) => void
  onOpen: (entry: Entry) => void
  onRemove: (entry: Entry) => void
  onDragStart: (index: number, e: DragEvent<HTMLDivElement>) => void
  onDragOver: (index: number, e: DragEvent<HTMLDivElement>) => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}

/** One image of the pick grid: its place, the picture, its name, and where it comes from. */
export function PickTile(p: Props) {
  const t = useT()
  const { entry } = p
  const src = entryThumb(entry, 256)
  const folder = entry.ref.kind === 'folder'
  const label = t('batch.pick.remove', { name: entry.filename })
  return (
    <div
      className={styles.tile}
      role="option"
      aria-selected={p.selected || p.cursor}
      data-cursor={p.cursor || undefined}
      data-selected={p.selected || undefined}
      data-pending={p.pending || undefined}
      data-drop={p.drop}
      data-dragging={p.dragging || undefined}
      data-testid="pick-tile"
      data-id={entry.imageId ?? undefined}
      data-key={entry.key}
      data-source={folder ? 'folder' : 'library'}
      title={entry.path ?? entry.filename}
      style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: p.width }}
      draggable
      onClick={(e) => p.onClick(p.index, e)}
      onDoubleClick={() => p.onOpen(entry)}
      onDragStart={(e) => p.onDragStart(p.index, e)}
      onDragOver={(e) => p.onDragOver(p.index, e)}
      onDrop={p.onDrop}
      onDragEnd={p.onDragEnd}
    >
      <div className={styles.frame} style={{ height: p.width }}>
        {src ? (
          <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <span className={styles.gone}>{t('dataset.fileGone')}</span>
        )}
        <span className={`${styles.order} mono`}>{p.index + 1}</span>
        <button
          type="button"
          className={styles.remove}
          tabIndex={-1}
          disabled={p.pending}
          aria-label={label}
          title={label}
          onClick={(e) => {
            e.stopPropagation()
            p.onRemove(entry)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      <span className={styles.captionRow}>
        {folder && (
          <span className={styles.source} title={t('dataset.folderImageHint')} data-testid="folder-badge">
            <Icon name="folder" size={11} />
            {t('dataset.folderImage')}
          </span>
        )}
        {entry.status !== 'ok' && (
          <span className={styles.status} data-testid="entry-status">
            {entry.status === 'missing' ? t('dataset.statusMissing') : t('dataset.statusChanged')}
          </span>
        )}
        <span className={`${styles.caption} mono`}>{entry.filename}</span>
      </span>
    </div>
  )
}
