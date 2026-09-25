import { useMemo, useState } from 'react'
import { useCategories, useImageDetail } from '../../../api/queries'
import type { TagCategory } from '../../../api/types'
import { useT, type MessageKey } from '../../../i18n'
import { tagKey as promptKey } from '../../../lib/prompt'
import { Icon } from '../../../ui/Icon'
import { TagInput } from '../../../ui/TagInput'
import { splitList, type DatasetForm } from '../datasetSettings'
import type { CaptionContent } from '../datasetTag'
import type { Entry } from '../entries'
import {
  CAPTION_TYPES,
  splitTags,
  tagCount,
  tagKey,
  withBooruText,
  withNl,
  withoutTag,
  withTags,
  withType,
  type CaptionType,
} from './captionContent'
import styles from './CaptionPanel.module.css'
import type { CaptionSession, ItemState } from './captionSession'
import { TagChips, TagInfoBox, type ChipFacts } from './TagChips'
import { TipoPanel } from './TipoPanel'
import { useTagZh, type ZhSource } from './tagAids'

const TYPE_LABEL: Record<CaptionType, MessageKey> = {
  booru: 'dataset.edit.typeBooru',
  both: 'dataset.edit.typeBoth',
  nl: 'dataset.edit.typeNl',
}

/** Why the batch rules take each tag out at export (the blacklist, a dropped category). */
function droppedTags(tags: readonly string[], form: DatasetForm, categories: ReadonlyMap<string, TagCategory> | undefined) {
  const blacklist = new Set(splitList(form.blacklist).map(tagKey))
  const cats = new Set<string>(form.removeCategories)
  const out = new Map<string, 'blacklist' | 'category'>()
  for (const tag of tags) {
    const key = tagKey(tag)
    if (blacklist.has(key)) out.set(key, 'blacklist')
    else if (cats.has(categories?.get(promptKey(tag)) ?? 'unknown')) out.set(key, 'category')
  }
  return out
}

/** Library confidence of each tag the tagger found on this image. */
function useConfidence(imageId: number | null): Map<string, number> {
  const detail = useImageDetail(imageId)
  return useMemo(() => {
    const out = new Map<string, number>()
    for (const tag of detail.data?.tags ?? []) if (tag.confidence !== null) out.set(tagKey(tag.tag), tag.confidence)
    return out
  }, [detail.data])
}

interface Props {
  form: DatasetForm
  entry: Entry
  item: ItemState
  session: CaptionSession
  locked: boolean
  zhSource: ZhSource
  /** Tags other images of this dataset use (offered first while typing). */
  vocabulary: readonly string[]
}

/** The one caption editor: the type, the tags as chips, the description, and help (TIPO, tag info, Chinese). */
export function CaptionEditor({ form, entry, item, session, locked, zhSource, vocabulary }: Props) {
  const t = useT()
  const [asText, setAsText] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [tipo, setTipo] = useState(false)
  const content = item.content
  const tags = useMemo(() => splitTags(content.booru_caption), [content.booru_caption])
  const categories = useCategories(tags.map(promptKey))
  const confidence = useConfidence(entry.imageId)
  const zh = useTagZh(tags, zhSource)
  const facts: ChipFacts = { categories: categories.data, confidence, zh: zh.data, dropped: droppedTags(tags, form, categories.data) }
  const edit = (change: (c: CaptionContent) => CaptionContent) => !locked && session.edit(entry.key, change)
  const over = form.maxTags > 0 && tagCount(content) > form.maxTags

  return (
    <div className={styles.editor}>
      <TypePicker type={content.caption_type} locked={locked} onPick={(type) => edit((c) => withType(c, type))} />

      <section className={styles.section} data-off={content.caption_type === 'nl' || undefined}>
        <header className={styles.sectionHead}>
          <span className={styles.label}>
            {t('dataset.edit.tags')} <span className="mono">{tags.length}</span>
          </span>
          {zh.isError && <span className={styles.warnText}>{t('dataset.edit.zhFailed')}</span>}
          <span className={styles.gap} />
          <button type="button" className="btn btn-ghost" aria-pressed={asText} onClick={() => setAsText(!asText)} data-testid="edit-as-text">
            {t('dataset.edit.asText')}
          </button>
        </header>
        {over && <p className={styles.warnText}>{t('dataset.edit.overMax', { n: tags.length, max: form.maxTags })}</p>}
        {asText ? (
          <textarea
            className={styles.textarea}
            value={content.booru_caption}
            rows={5}
            disabled={locked}
            aria-label={t('dataset.edit.tags')}
            spellCheck={false}
            onChange={(e) => edit((c) => withBooruText(c, e.target.value))}
            data-testid="edit-booru-text"
          />
        ) : (
          <TagChips tags={tags} facts={facts} disabled={locked} selected={selected} onSelect={setSelected} onRemove={(tag) => edit((c) => withoutTag(c, tag))} />
        )}
        {!locked && (
          <TagInput
            placeholder={t('dataset.edit.addTag')}
            label={t('dataset.edit.addTag')}
            vocabulary="global"
            preferred={vocabulary}
            onSubmit={(added) => {
              edit((c) => withTags(c, added).content)
              return true
            }}
            testId="edit-tag-input"
          />
        )}
        {selected && <TagInfoBox tag={selected} onClose={() => setSelected(null)} />}
        <div className={styles.toolRow}>
          <button type="button" className="btn btn-ghost" aria-expanded={tipo} onClick={() => setTipo(!tipo)} data-testid="edit-tipo-open">
            {t('dataset.edit.tipoOpen')}
          </button>
        </div>
        {tipo && (
          <TipoPanel
            tags={tags}
            imageId={entry.imageId}
            disabled={locked}
            onAdd={(picked) => edit((c) => withTags(c, picked).content)}
            onClose={() => setTipo(false)}
          />
        )}
      </section>

      <WordsBox content={content} locked={locked} onChange={(text) => edit((c) => withNl(c, text))} />
    </div>
  )
}

/** Booru tags, both, or natural language: what this image's caption writes. */
function TypePicker({ type, locked, onPick }: { type: CaptionType; locked: boolean; onPick: (type: CaptionType) => void }) {
  const t = useT()
  return (
    <>
      <div className={styles.types} role="radiogroup" aria-label={t('dataset.edit.type')}>
        <span className={styles.label}>{t('dataset.edit.type')}</span>
        {CAPTION_TYPES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={type === option}
            className={styles.typeButton}
            disabled={locked}
            onClick={() => onPick(option)}
            data-testid={`edit-type-${option}`}
          >
            {t(TYPE_LABEL[option])}
          </button>
        ))}
      </div>
      <p className={styles.muted}>{t(`dataset.edit.typeHint.${type}` as MessageKey)}</p>
    </>
  )
}

/** The natural-language description (dimmed while the type writes tags only). */
function WordsBox({ content, locked, onChange }: { content: CaptionContent; locked: boolean; onChange: (text: string) => void }) {
  const t = useT()
  return (
    <section className={styles.section} data-off={content.caption_type === 'booru' || undefined}>
      <header className={styles.sectionHead}>
        <span className={styles.label}>{t('dataset.edit.nl')}</span>
      </header>
      <textarea
        className={styles.textarea}
        value={content.nl_caption}
        rows={4}
        disabled={locked}
        placeholder={t('dataset.edit.nlPlaceholder')}
        aria-label={t('dataset.edit.nl')}
        onChange={(e) => onChange(e.target.value)}
        data-testid="edit-nl"
      />
    </section>
  )
}

/** Undo, the save state and what went wrong: the line under the editor's head. */
export function SaveLine({ item, session, entryKey }: { item: ItemState; session: CaptionSession; entryKey: string }) {
  const t = useT()
  return (
    <>
      <div className={styles.saveLine}>
        <span className={styles.saveState} data-state={item.status} aria-live="polite" data-testid="edit-save-state">
          {t(`dataset.edit.state.${item.status}` as MessageKey)}
        </span>
        <span className={styles.gap} />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => session.undo(entryKey)}
          disabled={item.undo.length === 0}
          title={t('dataset.edit.undoHint')}
          data-testid="edit-undo"
        >
          <Icon name="undo" size={14} />
          {t('dataset.edit.undo')}
        </button>
      </div>
      {item.status === 'conflict' && (
        <div className={styles.notice} role="alert" data-testid="edit-conflict">
          <p>{t('dataset.edit.conflict')}</p>
          <div className={styles.toolRow}>
            {item.lost && (
              <button type="button" className="btn" onClick={() => session.reapplyLost(entryKey)} data-testid="edit-conflict-mine">
                {t('dataset.edit.conflictMine')}
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => session.dismiss(entryKey)}>
              {t('dataset.edit.conflictKeep')}
            </button>
          </div>
        </div>
      )}
      {item.status === 'failed' && (
        <div className={styles.notice} role="alert" data-testid="edit-failed">
          <p>{t('dataset.edit.failed', { reason: item.error ?? '' })}</p>
          <button type="button" className="btn" onClick={() => session.retry(entryKey)}>
            {t('dataset.edit.retry')}
          </button>
        </div>
      )}
    </>
  )
}
