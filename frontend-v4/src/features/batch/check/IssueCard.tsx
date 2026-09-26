import { useState } from 'react'
import { useLang, useT } from '../../../i18n'
import type { Entry } from '../entries'
import { tagHolders } from './captionChecks'
import type { CheckIssue, IssueKind, TagPair } from './checkIssues'
import styles from './CheckStep.module.css'
import { ISSUE_TEXT, SEVERITY_TEXT } from './issueText'
import { TagDetail, type TagDetailScope } from './TagDetail'
import { Thumbs } from './Thumbs'

export interface IssueActions {
  remove: (keys: readonly string[]) => void
  readd: (keys: readonly string[]) => void
  pick: (keys: readonly string[]) => void
  open: (key: string) => void
  settings: () => void
  /** Training masks: edit one, or mask these automatically. */
  mask: (key: string) => void
  autoMask: (keys: readonly string[]) => void
  /** Rewrite these edited captions' tags the way the batch writes them (one undoable change). */
  unifyStyle: (keys: readonly string[]) => void
}

const REMOVE: ReadonlySet<IssueKind> = new Set(['file_changed', 'file_missing', 'unreadable', 'empty_caption', 'small', 'low_aesthetic', 'character_outlier'])
const PICK: ReadonlySet<IssueKind> = new Set([
  'empty_caption',
  'trigger_coverage',
  'small',
  'low_aesthetic',
  'too_long',
  'character_outlier',
  'rating_conflict',
  'rating_missing',
  'duplicates',
])
const OPEN: ReadonlySet<IssueKind> = new Set(['empty_caption', 'too_long', 'trigger_coverage', 'tag_style'])
const SETTINGS: ReadonlySet<IssueKind> = new Set(['trigger_missing', 'trigger_collision', 'trigger_coverage', 'too_long', 'rating_conflict', 'rating_missing'])
/** Their images have no caption to edit (the file is gone or changed). */
const LOCKED: ReadonlySet<IssueKind> = new Set(['file_changed', 'file_missing', 'unreadable'])

interface Props {
  issue: CheckIssue
  entries: ReadonlyMap<string, Entry>
  actions: IssueActions
  scope: TagDetailScope
}

/** One issue: what it is, what it means, the images (or tags) it is about, what can be done. */
export function IssueCard({ issue, entries, actions, scope }: Props) {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const [tag, setTag] = useState<string | null>(null)
  const n = issue.keys.length
  const text = issue.text
  const title = text ? (lang === 'en' ? text.en : text.zh) : t(ISSUE_TEXT[issue.kind].title, { n, ...issue.params })
  const detail = text ? (lang === 'en' ? text.detailEn : text.detailZh) : t(ISSUE_TEXT[issue.kind].detail, { n, ...issue.params })
  const openable = !LOCKED.has(issue.kind)
  const toggleTag = (next: string) => setTag((now) => (now === next ? null : next))
  const notes =
    issue.kind === 'too_long' && issue.notes
      ? Object.fromEntries(Object.entries(issue.notes).map(([k, v]) => [k, t('dataset.check.tokens', { n: Number(v) })]))
      : issue.notes

  return (
    <article className={styles.issue} data-severity={issue.severity} data-kind={issue.kind} data-testid="check-issue">
      <header className={styles.issueHead}>
        <span className={styles.severity}>{t(SEVERITY_TEXT[issue.severity])}</span>
        <h3 className={styles.issueTitle}>{title}</h3>
      </header>
      <p className={styles.detail}>{detail}</p>
      {issue.groups ? (
        <div className={styles.groups}>
          {issue.groups.map((group) => (
            <Thumbs key={group[0]} keys={group} entries={entries} notes={notes} onOpen={actions.open} firstKept />
          ))}
        </div>
      ) : (
        n > 0 && <Thumbs keys={issue.keys} entries={entries} notes={notes} onOpen={issue.kind === 'no_mask' ? actions.mask : openable ? actions.open : undefined} />
      )}
      {issue.pairs && <Pairs pairs={issue.pairs} scope={scope} onTag={toggleTag} onPick={actions.pick} />}
      {issue.tags && <TagChips tags={issue.tags} onTag={toggleTag} active={tag} />}
      <IssueButtons issue={issue} actions={actions} />
      {tag && <TagDetail tag={tag} scope={scope} onPick={actions.pick} onClose={() => setTag(null)} />}
    </article>
  )
}

function IssueButtons({ issue, actions }: { issue: CheckIssue; actions: IssueActions }) {
  const t = useT()
  const { kind, keys } = issue
  const n = keys.length
  const extras = issue.groups?.flatMap((g) => g.slice(1)) ?? []
  const buttons = [
    kind === 'no_mask' && (
      <button key="auto" type="button" className="btn" onClick={() => actions.autoMask(keys)} data-testid="check-auto-mask">
        {t('dataset.check.autoMask', { n })}
      </button>
    ),
    kind === 'no_mask' && (
      <button key="mask" type="button" className="btn" onClick={() => actions.mask(keys[0] as string)} data-testid="check-edit-mask">
        {t('dataset.check.editMasks')}
      </button>
    ),
    kind === 'tag_style' && (
      <button key="style" type="button" className="btn" onClick={() => actions.unifyStyle(keys)} data-testid="check-unify-style">
        {t('dataset.check.unifyStyle', { n })}
      </button>
    ),
    kind === 'file_changed' && (
      <button key="readd" type="button" className="btn" onClick={() => actions.readd(keys)} data-testid="check-readd">
        {t('dataset.check.readd', { n })}
      </button>
    ),
    extras.length > 0 && (
      <button key="keep" type="button" className="btn" onClick={() => actions.remove(extras)} data-testid="check-keep-first">
        {t('dataset.check.keepFirst', { n: extras.length })}
      </button>
    ),
    n > 0 && PICK.has(kind) && (
      <button key="pick" type="button" className="btn" onClick={() => actions.pick(keys)} data-testid="check-pick">
        {t('dataset.check.pick', { n })}
      </button>
    ),
    n > 0 && OPEN.has(kind) && (
      <button key="open" type="button" className="btn" onClick={() => actions.open(keys[0] as string)} data-testid="check-open">
        {t('dataset.check.open')}
      </button>
    ),
    SETTINGS.has(kind) && (
      <button key="settings" type="button" className="btn btn-ghost" onClick={actions.settings} data-testid="check-settings">
        {t('dataset.check.openSettings')}
      </button>
    ),
    n > 0 && REMOVE.has(kind) && (
      <button key="remove" type="button" className="btn" onClick={() => actions.remove(keys)} data-testid="check-remove">
        {t('dataset.check.remove', { n })}
      </button>
    ),
  ].filter(Boolean)
  if (buttons.length === 0) return null
  return <div className={styles.issueActions}>{buttons}</div>
}

/** Tags shown before "show all" (a display choice; all are listed on request). */
const SHOWN_TAGS = 40

function TagChips({ tags, onTag, active }: { tags: readonly string[]; onTag: (tag: string) => void; active: string | null }) {
  const t = useT()
  const [all, setAll] = useState(false)
  const shown = all ? tags : tags.slice(0, SHOWN_TAGS)
  return (
    <div className={styles.tagChips}>
      {shown.map((tag) => (
        <button key={tag} type="button" className={styles.tagChip} aria-pressed={active === tag} onClick={() => onTag(tag)} data-testid="check-tag">
          {tag}
        </button>
      ))}
      {tags.length > shown.length && (
        <button type="button" className="btn btn-ghost" onClick={() => setAll(true)}>
          {t('dataset.check.showAll', { n: tags.length })}
        </button>
      )}
    </div>
  )
}

interface PairsProps {
  pairs: readonly TagPair[]
  scope: TagDetailScope
  onTag: (tag: string) => void
  onPick: (keys: readonly string[]) => void
}

function Pairs({ pairs, scope, onTag, onPick }: PairsProps) {
  const t = useT()
  const [all, setAll] = useState(false)
  const shown = all ? pairs : pairs.slice(0, SHOWN_TAGS)
  const both = (p: TagPair) => {
    const b = new Set(tagHolders(scope.finals, p.b))
    return tagHolders(scope.finals, p.a).filter((k) => b.has(k))
  }
  return (
    <ul className={styles.pairs}>
      {shown.map((p) => (
        <li key={`${p.a}|${p.b}`} className={styles.pair} data-testid="check-pair">
          <button type="button" className={styles.tagChip} onClick={() => onTag(p.a)}>
            {p.a}
          </button>
          <span className={styles.plus}>+</span>
          <button type="button" className={styles.tagChip} onClick={() => onTag(p.b)}>
            {p.b}
          </button>
          <span className={styles.pairCount}>{t('dataset.check.pairCount', { n: p.together, pct: Math.round(p.ratio * 100) })}</span>
          <button type="button" className="btn btn-ghost" onClick={() => onPick(both(p))}>
            {t('dataset.check.pick', { n: p.together })}
          </button>
        </li>
      ))}
      {pairs.length > shown.length && (
        <li>
          <button type="button" className="btn btn-ghost" onClick={() => setAll(true)}>
            {t('dataset.check.showAll', { n: pairs.length })}
          </button>
        </li>
      )}
    </ul>
  )
}
