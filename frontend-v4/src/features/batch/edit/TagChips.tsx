import type { TagCategory } from '../../../api/types'
import { useT, type MessageKey } from '../../../i18n'
import { tagKey as promptKey } from '../../../lib/prompt'
import { Icon } from '../../../ui/Icon'
import { tagKey } from './captionContent'
import styles from './CaptionPanel.module.css'
import { useTagInfo, type TagInfo } from './tagAids'
import { displayTag } from './tagStyle'

export interface ChipFacts {
  categories: ReadonlyMap<string, TagCategory> | undefined
  /** Library confidence by tagKey (Library images the tagger ran on). */
  confidence: ReadonlyMap<string, number>
  /** Chinese by lowercase tag, when the reading aid is on. */
  zh: ReadonlyMap<string, string> | undefined
  /** Why the batch rules take the tag out at export (by tagKey), if they do. */
  dropped: ReadonlyMap<string, 'blacklist' | 'category'>
}

interface Props {
  tags: readonly string[]
  facts: ChipFacts
  disabled: boolean
  selected: string | null
  onSelect: (tag: string | null) => void
  onRemove: (tag: string) => void
}

const DROP_NOTE: Record<'blacklist' | 'category', MessageKey> = {
  blacklist: 'dataset.edit.droppedBlacklist',
  category: 'dataset.edit.droppedCategory',
}

/** The caption's tags as chips in their category colour; a click shows what the app knows about one. */
export function TagChips({ tags, facts, disabled, selected, onSelect, onRemove }: Props) {
  const t = useT()
  if (tags.length === 0) return <p className={styles.muted}>{t('dataset.edit.noTags')}</p>
  return (
    <ul className={styles.chips} data-testid="edit-chips">
      {tags.map((tag) => {
        const key = tagKey(tag)
        const category = facts.categories?.get(promptKey(tag)) ?? 'unknown'
        const confidence = facts.confidence.get(key)
        const zh = facts.zh?.get(tag.toLowerCase())
        const dropped = facts.dropped.get(key)
        return (
          <li key={key} className={`chip cat-${category} ${styles.chip}`} data-dropped={dropped || undefined} data-selected={selected === tag || undefined} data-testid="edit-chip" data-tag={tag}>
            <button
              type="button"
              className={styles.chipText}
              onClick={() => onSelect(selected === tag ? null : tag)}
              title={dropped ? t(DROP_NOTE[dropped]) : t('dataset.edit.tagInfoOpen')}
            >
              {displayTag(tag)}
              {zh && <span className={styles.zh}>{zh}</span>}
              {confidence !== undefined && <span className={`${styles.conf} mono`}>{Math.round(confidence * 100)}</span>}
            </button>
            {!disabled && (
              <button type="button" className={styles.chipRemove} onClick={() => onRemove(tag)} aria-label={t('card.removeTag', { tag })} title={t('card.removeTag', { tag })}>
                <Icon name="close" size={10} />
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.infoRow}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function InfoBody({ info }: { info: TagInfo }) {
  const t = useT()
  const list = (tags: string[]) => (tags.length ? tags.slice(0, 12).join(', ') : '—')
  return (
    <dl className={styles.infoList}>
      <Row label={t('dataset.edit.infoCategory')}>{info.category ?? '—'}</Row>
      {info.zh && <Row label={t('dataset.edit.infoZh')}>{info.zh}</Row>}
      <Row label={t('dataset.edit.infoDanbooru')}>{info.found_in_vocab ? info.danbooru_count.toLocaleString() : t('dataset.edit.infoNotInVocab')}</Row>
      <Row label={t('dataset.edit.infoLibrary')}>{info.library_count.toLocaleString()}</Row>
      {info.copyright && <Row label={t('dataset.edit.infoCopyright')}>{info.copyright}</Row>}
      {info.aliases.length > 0 && <Row label={t('dataset.edit.infoAliases')}>{list(info.aliases)}</Row>}
      <Row label={t('dataset.edit.infoImplies')}>{list(info.implies)}</Row>
      <Row label={t('dataset.edit.infoImpliedBy')}>{list(info.implied_by)}</Row>
    </dl>
  )
}

/** What the app knows about one tag: category, how common it is, aliases, Chinese, what it implies. */
export function TagInfoBox({ tag, onClose }: { tag: string; onClose: () => void }) {
  const t = useT()
  const info = useTagInfo(tag)
  return (
    <section className={styles.info} aria-label={t('dataset.edit.tagInfo', { tag })} data-testid="edit-tag-info">
      <header className={styles.infoHead}>
        <span className="mono">{info.data?.canonical ?? tag}</span>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
          <Icon name="close" size={12} />
        </button>
      </header>
      {info.isError ? (
        <p className={styles.muted}>{t('dataset.edit.infoFailed', { reason: info.error.message })}</p>
      ) : info.data ? (
        <InfoBody info={info.data} />
      ) : (
        <p className={styles.muted}>{t('grid.loading')}</p>
      )}
    </section>
  )
}
