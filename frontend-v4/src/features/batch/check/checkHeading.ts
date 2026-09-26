import type { MessageKey } from '../../../i18n'
import type { SourceStatus } from './useChecks'

export interface CheckHeading {
  title: MessageKey
  /** The count the title shows (issues, or checks that did not finish). */
  n: number
  /** A check failed: the list may miss issues, so the step says so under the title. */
  incomplete: boolean
}

/**
 * What the issues heading says. "No issues" only when every check answered
 * and found nothing: a failed check means nothing is known about what it
 * looks for, which is not the same as nothing wrong.
 */
export function checkHeading(issueCount: number, sources: readonly { status: SourceStatus }[]): CheckHeading {
  const failed = sources.filter((s) => s.status === 'failed').length
  const incomplete = failed > 0
  if (issueCount > 0) return { title: 'dataset.check.issueCount', n: issueCount, incomplete }
  if (sources.some((s) => s.status === 'checking')) return { title: 'dataset.check.stillChecking', n: 0, incomplete }
  if (incomplete) return { title: 'dataset.check.unfinishedTitle', n: failed, incomplete }
  return { title: 'dataset.check.noIssues', n: 0, incomplete: false }
}
