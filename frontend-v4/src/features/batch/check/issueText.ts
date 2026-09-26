import type { MessageKey } from '../../../i18n'
import type { IssueKind } from './checkIssues'

/** Each kind's title (with {n} images) and what it means for the training. */
export const ISSUE_TEXT: Record<IssueKind, { title: MessageKey; detail: MessageKey }> = {
  file_changed: { title: 'dataset.check.fileChanged', detail: 'dataset.check.fileChanged.detail' },
  file_missing: { title: 'dataset.check.fileMissing', detail: 'dataset.check.fileMissing.detail' },
  unreadable: { title: 'dataset.check.unreadable', detail: 'dataset.check.unreadable.detail' },
  empty_caption: { title: 'dataset.check.emptyCaption', detail: 'dataset.check.emptyCaption.detail' },
  trigger_missing: { title: 'dataset.check.triggerMissing', detail: 'dataset.check.triggerMissing.detail' },
  trigger_coverage: { title: 'dataset.check.triggerCoverage', detail: 'dataset.check.triggerCoverage.detail' },
  trigger_collision: { title: 'dataset.check.triggerCollision', detail: 'dataset.check.triggerCollision.detail' },
  duplicates: { title: 'dataset.check.duplicates', detail: 'dataset.check.duplicates.detail' },
  small: { title: 'dataset.check.small', detail: 'dataset.check.small.detail' },
  low_aesthetic: { title: 'dataset.check.lowAesthetic', detail: 'dataset.check.lowAesthetic.detail' },
  too_long: { title: 'dataset.check.tooLong', detail: 'dataset.check.tooLong.detail' },
  character_outlier: { title: 'dataset.check.outlier', detail: 'dataset.check.outlier.detail' },
  fullbody: { title: 'dataset.check.fullbody', detail: 'dataset.check.fullbody.detail' },
  rating_conflict: { title: 'dataset.check.ratingConflict', detail: 'dataset.check.ratingConflict.detail' },
  rating_missing: { title: 'dataset.check.ratingMissing', detail: 'dataset.check.ratingMissing.detail' },
  rare_tags: { title: 'dataset.check.rareTags', detail: 'dataset.check.rareTags.detail' },
  cooccur: { title: 'dataset.check.cooccur', detail: 'dataset.check.cooccur.detail' },
  health_other: { title: 'dataset.check.other', detail: 'dataset.check.other' },
}

export const SEVERITY_TEXT: Record<'high' | 'medium' | 'low', MessageKey> = {
  high: 'dataset.check.severity.high',
  medium: 'dataset.check.severity.medium',
  low: 'dataset.check.severity.low',
}
