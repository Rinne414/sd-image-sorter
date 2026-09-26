import { describe, expect, test } from 'vitest'
import { checkHeading } from './checkHeading'
import type { SourceStatus } from './useChecks'

const sources = (...statuses: SourceStatus[]) => statuses.map((status) => ({ status }))

describe('the issues heading', () => {
  test('"no issues" only when every check answered and found nothing', () => {
    expect(checkHeading(0, sources('done', 'done', 'na'))).toEqual({ title: 'dataset.check.noIssues', n: 0, incomplete: false })
  })

  test('a check that failed is never read as "no issues": the heading counts the unfinished checks', () => {
    expect(checkHeading(0, sources('done', 'failed', 'done'))).toEqual({ title: 'dataset.check.unfinishedTitle', n: 1, incomplete: true })
    expect(checkHeading(0, sources('failed', 'failed', 'na'))).toEqual({ title: 'dataset.check.unfinishedTitle', n: 2, incomplete: true })
  })

  test('while a check still runs it says so, and a failure beside it is still flagged', () => {
    expect(checkHeading(0, sources('checking', 'done'))).toEqual({ title: 'dataset.check.stillChecking', n: 0, incomplete: false })
    expect(checkHeading(0, sources('checking', 'failed'))).toEqual({ title: 'dataset.check.stillChecking', n: 0, incomplete: true })
  })

  test('issues found are counted; a failed check beside them still marks the list incomplete', () => {
    expect(checkHeading(3, sources('done', 'done'))).toEqual({ title: 'dataset.check.issueCount', n: 3, incomplete: false })
    expect(checkHeading(3, sources('done', 'failed'))).toEqual({ title: 'dataset.check.issueCount', n: 3, incomplete: true })
  })
})
