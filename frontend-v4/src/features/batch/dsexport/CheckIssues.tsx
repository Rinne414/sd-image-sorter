import { useT } from '../../../i18n'
import pix from '../ExportStep.module.css'
import styles from './DatasetExport.module.css'
import type { Choices } from './plan'
import { CAPTION_LABELS, groupIssues, type IssueGroup, type ReadinessReport } from './report'
import { LABEL_KEY } from './texts'
import type { Entry } from '../entries'

/** Names shown per issue; the rest are counted. */
const MAX_NAMES = 6

interface Props {
  report: ReadinessReport
  entries: readonly Entry[]
  choices: Choices
  /** A verified package (kohya, Anima) must hold every image: no leaving out. */
  isPackage: boolean
  onRemove: (keys: readonly string[]) => void
  onOpen: (key: string) => void
  onRerun: (choices: Choices) => void
}

function Group({ group, onRemove, onOpen }: { group: IssueGroup; onRemove: Props['onRemove']; onOpen: Props['onOpen'] }) {
  const t = useT()
  const more = group.names.length - MAX_NAMES
  const shown = group.names.slice(0, MAX_NAMES).join(t('batch.listSep'))
  return (
    <li className={styles.group} data-severity={group.severity} data-label={group.label} data-testid="ds-issue">
      <span className={styles.groupHead} title={group.detail}>
        <span>{t(LABEL_KEY[group.label])}</span>
        <span className="mono">{group.count}</span>
      </span>
      {shown && <p className={styles.groupNames}>{more > 0 ? t('dataset.export.issueMore', { names: shown, n: more }) : shown}</p>}
      {group.keys.length > 0 && group.severity === 'blocker' && (
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={() => onRemove(group.keys)} data-testid="ds-issue-remove">
            {t('dataset.export.takeOut', { n: group.keys.length })}
          </button>
          {CAPTION_LABELS.has(group.label) && (
            <button type="button" className="btn btn-ghost" onClick={() => onOpen(group.keys[0] as string)} data-testid="ds-issue-open">
              {t('dataset.export.openEditor')}
            </button>
          )}
        </div>
      )}
    </li>
  )
}

/** The check found problems that stop the export: nothing was written. Each says what can be done. */
export function CheckIssues({ report, entries, choices, isPackage, onRemove, onOpen, onRerun }: Props) {
  const t = useT()
  const s = report.summary
  const groups = groupIssues(report.issues, entries)
  const canSkip = s.skippable_items > 0 && !isPackage && !choices.skipBlocked
  return (
    <div className={pix.problem} data-tone="danger" role="alert" data-testid="ds-blocked">
      <p>{t('dataset.export.blocked', { n: s.blocker_count })}</p>
      <ul className={styles.groups}>
        {groups.map((g) => (
          <Group key={`${g.severity}:${g.label}`} group={g} onRemove={onRemove} onOpen={onOpen} />
        ))}
      </ul>
      {report.issues_truncated && <p className={styles.note}>{t('dataset.export.moreIssues', { n: report.total_issues - report.issues.length })}</p>}
      {s.skippable_items > 0 && isPackage && <p className={styles.note}>{t('dataset.export.noSkipPackage')}</p>}
      <div className={pix.choices}>
        {canSkip && (
          <button type="button" className="btn btn-primary" onClick={() => onRerun({ ...choices, skipBlocked: true })} data-testid="ds-skip-blocked">
            {t('dataset.export.skipBlocked', { n: s.skippable_items })}
          </button>
        )}
        {s.empty_caption_items > 0 && !choices.allowEmpty && (
          <button type="button" className="btn" onClick={() => onRerun({ ...choices, allowEmpty: true })} data-testid="ds-allow-empty">
            {t('dataset.export.allowEmpty', { n: s.empty_caption_items })}
          </button>
        )}
        <button type="button" className="btn" onClick={() => onRerun(choices)} data-testid="ds-check-again">
          {t('dataset.export.checkAgain')}
        </button>
      </div>
    </div>
  )
}
