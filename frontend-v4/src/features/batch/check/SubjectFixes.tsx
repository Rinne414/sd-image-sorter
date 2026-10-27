import { useState } from 'react'
import { useT } from '../../../i18n'
import { entryThumb, type Entry } from '../entries'
import { tagKey } from '../edit/captionContent'
import type { SubjectFix } from './checkIssues'
import styles from './CheckStep.module.css'

interface Props {
  fixes: readonly SubjectFix[]
  entries: ReadonlyMap<string, Entry>
  /** Common tags of the batch these fixes would take off (the rules put them on every caption). */
  common: readonly string[]
  /** Applies the ticked fixes (one undoable change). */
  onApply: (fixes: readonly SubjectFix[]) => Promise<void>
  /** Moves each common tag into the captions of the images that keep it, so its `without` can lose it. */
  onMoveCommon: (moves: readonly { tag: string; without: readonly string[] }[]) => Promise<void>
  onOpen: (key: string) => void
}

/** Rows shown before "show all" (a display choice: every row can be ticked and applied). */
const SHOWN_ROWS = 30

/**
 * The proposed subject-count fixes as a preview: for each image the count tags
 * it keeps and the ones it loses, a tick box each (all ticked to start with),
 * and one button that writes the ticked ones.
 */
export function SubjectFixes({ fixes, entries, common, onApply, onMoveCommon, onOpen }: Props) {
  const t = useT()
  const [off, setOff] = useState<ReadonlySet<string>>(new Set())
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const ticked = fixes.filter((fix) => !off.has(fix.key))
  const shown = all ? fixes : fixes.slice(0, SHOWN_ROWS)
  const toggle = (key: string) =>
    setOff((now) => {
      const next = new Set(now)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const apply = async () => {
    setBusy(true)
    try {
      await onApply(ticked)
    } finally {
      setBusy(false)
    }
  }
  const moveCommon = async () => {
    setBusy(true)
    try {
      // The ticked images are the ones to lose the tag; every other image keeps it.
      await onMoveCommon(common.map((tag) => ({ tag, without: ticked.filter((fix) => fix.drop.some((d) => tagKey(d) === tagKey(tag))).map((fix) => fix.key) })))
    } finally {
      setBusy(false)
    }
  }
  const commonText = common.map((tag) => `“${tag}”`).join(', ')

  return (
    <div className={styles.subjectFixes} data-testid="check-subject-fixes">
      {common.length > 0 && (
        <div className={styles.subjectCommon} data-testid="check-subject-common">
          <p className={styles.note}>{t('dataset.check.subjectCommonNote', { tags: commonText })}</p>
          <button type="button" className="btn" disabled={busy} onClick={() => void moveCommon()} data-testid="check-subject-move-common">
            {t('dataset.check.subjectMoveCommon', { tags: commonText })}
          </button>
        </div>
      )}
      <ul className={styles.subjectList}>
        {shown.map((fix) => {
          const entry = entries.get(fix.key)
          const src = entry ? entryThumb(entry, 96) : null
          return (
            <li key={fix.key} className={styles.subjectRow} data-testid="check-subject-row" data-key={fix.key}>
              <input type="checkbox" checked={!off.has(fix.key)} onChange={() => toggle(fix.key)} aria-label={entry?.filename ?? fix.key} data-testid="check-subject-tick" />
              <button type="button" className={styles.subjectPic} onClick={() => onOpen(fix.key)} title={entry?.filename}>
                {src && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />}
              </button>
              <span className={`${styles.subjectName} mono`}>{entry?.filename ?? fix.key}</span>
              <span className={styles.subjectTags}>
                {fix.keep.map((tag) => (
                  <span key={`keep:${tag}`} className={styles.keepTag} title={t('dataset.check.subjectKeeps')}>
                    {tag}
                  </span>
                ))}
                {fix.drop.map((tag) => (
                  <span key={`drop:${tag}`} className={styles.dropTag} title={t('dataset.check.subjectDrops')}>
                    {tag}
                  </span>
                ))}
              </span>
            </li>
          )
        })}
      </ul>
      {fixes.length > shown.length && (
        <button type="button" className="btn btn-ghost" onClick={() => setAll(true)}>
          {t('dataset.check.showAll', { n: fixes.length })}
        </button>
      )}
      <div className={styles.issueActions}>
        <button type="button" className="btn" disabled={busy || ticked.length === 0} onClick={() => void apply()} data-testid="check-subject-apply">
          {t('dataset.check.subjectApply', { n: ticked.length })}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOff(off.size === 0 ? new Set(fixes.map((f) => f.key)) : new Set())} data-testid="check-subject-toggle">
          {off.size === 0 ? t('dataset.check.subjectUntickAll') : t('dataset.check.subjectTickAll')}
        </button>
      </div>
    </div>
  )
}
