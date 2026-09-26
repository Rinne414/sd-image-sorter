import { describe, expect, test } from 'vitest'
import type { Job } from './jobs'
import type { JobProgress, JobStatus } from './progress'
import { badgeTitle, endedJobs } from './titleBadge'

const progress = (status: JobStatus, failedCount = 0): JobProgress => ({
  status, current: 0, total: 2, unit: 'images', succeeded: 0, failedCount, failures: [], alreadyGone: 0,
  topTags: [], needsRestart: false, restartAdvised: false, toReview: 0, phase: null, updated: 0, currentItem: null, message: '',
})

const job = (id: string, status: JobStatus, failedCount = 0): Job => ({
  id, kind: 'tag', count: 2, destination: null, ids: [], adopted: false, pollErrors: 0, ctx: {}, label: null, progress: progress(status, failedCount),
})

describe('titleBadge', () => {
  test('the title counts jobs that ended while away, and says when one went wrong', () => {
    expect(badgeTitle('SD Image Sorter', 0, false)).toBe('SD Image Sorter')
    expect(badgeTitle('SD Image Sorter', 2, false)).toBe('(2) SD Image Sorter')
    expect(badgeTitle('SD Image Sorter', 1, true)).toBe('(1!) SD Image Sorter')
  })

  test('only jobs that were running and have now ended count; new or already finished ones do not', () => {
    const before = [job('a', 'running'), job('b', 'queued'), job('c', 'done')]
    const after = [job('a', 'done'), job('b', 'running'), job('c', 'done'), job('d', 'done')]
    expect(endedJobs(before, after).map((j) => j.id)).toEqual(['a'])
    const failed = endedJobs([job('e', 'running')], [job('e', 'error')])
    expect(failed.map((j) => j.progress.status)).toEqual(['error'])
    expect(endedJobs([job('f', 'running')], [])).toEqual([])
  })
})
