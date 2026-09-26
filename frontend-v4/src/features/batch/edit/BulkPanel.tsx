import { useMemo, useState } from 'react'
import { useT, type MessageKey } from '../../../i18n'
import { CATEGORIES } from '../datasetSettings'
import type { CaptionContent } from '../datasetTag'
import styles from './Bulk.module.css'
import { CAPTION_TYPES, splitTags, type CaptionType } from './captionContent'
import { CATEGORY_ORDER, findPattern, planOp, type BulkOp, type CategoryOf, type FindMode, type FindTarget, type Position } from './captionOps'

export interface BulkContext {
  contents: ReadonlyMap<string, CaptionContent>
  /** The images an operation changes: the selection, or every image. */
  keys: readonly string[]
  categoryOf: CategoryOf
  busy: boolean
  run: (op: BulkOp, label: string) => void
}

const TYPE_LABEL: Record<CaptionType, MessageKey> = {
  booru: 'dataset.edit.typeBooru',
  both: 'dataset.edit.typeBoth',
  nl: 'dataset.edit.typeNl',
}

/** The operation's button: what it does and how many captions it changes (nothing to change: it says so). */
function Apply({ ctx, op, label, text, testId }: { ctx: BulkContext; op: BulkOp | null; label: string; text: string; testId: string }) {
  const t = useT()
  const n = useMemo(() => (op ? planOp(ctx.contents, ctx.keys, op, ctx.categoryOf).length : 0), [ctx.contents, ctx.keys, ctx.categoryOf, op])
  return (
    <button type="button" className="btn" disabled={!op || n === 0 || ctx.busy} onClick={() => op && ctx.run(op, label)} data-testid={testId}>
      {op && n === 0 ? t('dataset.bulk.noChange') : t('dataset.bulk.apply', { what: text, n })}
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.op}>
      <h4 className={styles.opTitle}>{title}</h4>
      {children}
    </section>
  )
}

function AddRemove({ ctx }: { ctx: BulkContext }) {
  const t = useT()
  const [text, setText] = useState('')
  const [position, setPosition] = useState<Position>('back')
  const tags = splitTags(text)
  const list = tags.join(', ')
  const add: BulkOp | null = tags.length ? { kind: 'add', tags, position } : null
  const remove: BulkOp | null = tags.length ? { kind: 'remove', tags } : null
  return (
    <Section title={t('dataset.bulk.tagsTitle')}>
      <input className={styles.input} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('dataset.bulk.tagsPlaceholder')} aria-label={t('dataset.bulk.tagsTitle')} data-testid="bulk-tags" />
      <div className={styles.row2} role="radiogroup" aria-label={t('dataset.bulk.position')}>
        {(['front', 'back'] as const).map((p) => (
          <label key={p} className={styles.check}>
            <input type="radio" name="bulk-position" checked={position === p} onChange={() => setPosition(p)} />
            {t(p === 'front' ? 'dataset.bulk.front' : 'dataset.bulk.back')}
          </label>
        ))}
      </div>
      <div className={styles.actions}>
        <Apply ctx={ctx} op={add} label={t('dataset.bulk.labelAdd', { tags: list })} text={t('dataset.bulk.add')} testId="bulk-add" />
        <Apply ctx={ctx} op={remove} label={t('dataset.bulk.labelRemove', { tags: list })} text={t('dataset.bulk.remove')} testId="bulk-remove" />
      </div>
    </Section>
  )
}

function FindReplace({ ctx }: { ctx: BulkContext }) {
  const t = useT()
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [mode, setMode] = useState<FindMode>('tag')
  const [target, setTarget] = useState<FindTarget>('tags')
  const [ignoreCase, setIgnoreCase] = useState(false)
  const pattern = findPattern(find, mode, ignoreCase)
  const problem = pattern && !(pattern instanceof RegExp) ? pattern.error : null
  const op: BulkOp | null = find && !problem ? { kind: 'replace', find, replace, mode, target: mode === 'tag' ? 'tags' : target, ignoreCase } : null
  return (
    <Section title={t('dataset.bulk.findTitle')}>
      <div className={styles.row2}>
        <input className={styles.input} value={find} onChange={(e) => setFind(e.target.value)} placeholder={t('dataset.bulk.find')} aria-label={t('dataset.bulk.find')} spellCheck={false} data-testid="bulk-find" />
        <input className={styles.input} value={replace} onChange={(e) => setReplace(e.target.value)} placeholder={t('dataset.bulk.replaceWith')} aria-label={t('dataset.bulk.replaceWith')} spellCheck={false} data-testid="bulk-replace-with" />
      </div>
      <div className={styles.row2}>
        <select className={styles.select} value={mode} onChange={(e) => setMode(e.target.value as FindMode)} aria-label={t('dataset.bulk.mode')} data-testid="bulk-find-mode">
          <option value="tag">{t('dataset.bulk.modeTag')}</option>
          <option value="text">{t('dataset.bulk.modeText')}</option>
          <option value="regex">{t('dataset.bulk.modeRegex')}</option>
        </select>
        <select className={styles.select} value={mode === 'tag' ? 'tags' : target} disabled={mode === 'tag'} onChange={(e) => setTarget(e.target.value as FindTarget)} aria-label={t('dataset.bulk.target')}>
          <option value="tags">{t('dataset.bulk.targetTags')}</option>
          <option value="words">{t('dataset.bulk.targetWords')}</option>
          <option value="both">{t('dataset.bulk.targetBoth')}</option>
        </select>
      </div>
      {mode !== 'tag' && (
        <label className={styles.check}>
          <input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} />
          {t('dataset.bulk.ignoreCase')}
        </label>
      )}
      <p className={styles.muted}>{t(`dataset.bulk.modeHint.${mode}` as MessageKey)}</p>
      {problem && <p className={styles.problem}>{t('dataset.bulk.badPattern', { reason: problem })}</p>}
      <Apply ctx={ctx} op={op} label={t('dataset.bulk.labelReplace', { find, replace })} text={t('dataset.bulk.replace')} testId="bulk-replace" />
    </Section>
  )
}

function Cleanup({ ctx }: { ctx: BulkContext }) {
  const t = useT()
  const [cats, setCats] = useState<string[]>([])
  const order = CATEGORY_ORDER.map((c) => t(`dataset.cat.${c}` as MessageKey)).join(' → ')
  return (
    <Section title={t('dataset.bulk.cleanTitle')}>
      <div className={styles.actions}>
        <Apply ctx={ctx} op={{ kind: 'dedupe' }} label={t('dataset.bulk.labelDedupe')} text={t('dataset.bulk.dedupe')} testId="bulk-dedupe" />
        <Apply ctx={ctx} op={{ kind: 'sortByCategory', order: CATEGORY_ORDER }} label={t('dataset.bulk.labelSort')} text={t('dataset.bulk.sort')} testId="bulk-sort" />
      </div>
      <p className={styles.muted}>{t('dataset.bulk.sortOrder', { order })}</p>
      <div className={styles.cats} role="group" aria-label={t('dataset.bulk.catsLabel')}>
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className={`chip cat-${c} ${styles.catChip}`}
            aria-pressed={cats.includes(c)}
            onClick={() => setCats(cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c])}
          >
            {t(`dataset.cat.${c}` as MessageKey)}
          </button>
        ))}
      </div>
      <Apply
        ctx={ctx}
        op={cats.length ? { kind: 'removeCategories', categories: cats } : null}
        label={t('dataset.bulk.labelCats', { cats: cats.map((c) => t(`dataset.cat.${c}` as MessageKey)).join('、') })}
        text={t('dataset.bulk.removeCats')}
        testId="bulk-remove-cats"
      />
    </Section>
  )
}

function SetType({ ctx }: { ctx: BulkContext }) {
  const t = useT()
  return (
    <Section title={t('dataset.bulk.typeTitle')}>
      <div className={styles.actions}>
        {CAPTION_TYPES.map((type) => (
          <Apply key={type} ctx={ctx} op={{ kind: 'type', type }} label={t('dataset.bulk.labelType', { type: t(TYPE_LABEL[type]) })} text={t(TYPE_LABEL[type])} testId={`bulk-type-${type}`} />
        ))}
      </div>
    </Section>
  )
}

/** The bulk operations; each button names how many captions it changes in the scope above. */
export function BulkOps({ ctx }: { ctx: BulkContext }) {
  return (
    <>
      <AddRemove ctx={ctx} />
      <FindReplace ctx={ctx} />
      <Cleanup ctx={ctx} />
      <SetType ctx={ctx} />
    </>
  )
}

