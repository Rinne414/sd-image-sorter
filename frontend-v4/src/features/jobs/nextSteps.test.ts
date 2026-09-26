import { describe, expect, test } from 'vitest'
import type { Job } from './jobs'
import type { JobProgress, JobStatus } from './progress'
import { tagNextSteps } from './nextSteps'

const progress = (status: JobStatus, succeeded: number, failures: number[] = []): JobProgress => ({
  status, current: 3, total: 3, unit: 'images', succeeded, failedCount: failures.length,
  failures: failures.map((id) => ({ id, name: '', reason: 'x' })), alreadyGone: 0,
  topTags: [], needsRestart: false, restartAdvised: false, toReview: 0, phase: null, updated: 0, currentItem: null, message: '',
})

const tagJob = (fields: Partial<Job>): Job => ({
  id: 'tag-1', kind: 'tag', count: 3, destination: null, ids: [4, 5, 6], adopted: false, pollErrors: 0, ctx: {}, label: null,
  progress: progress('done', 3), ...fields,
})

describe('tagNextSteps', () => {
  test('a finished run of ours on picked images offers the images it tagged', () => {
    expect(tagNextSteps(tagJob({}))).toEqual([4, 5, 6])
    expect(tagNextSteps(tagJob({ progress: progress('done', 2, [5]) }))).toEqual([4, 6])
  })

  test('nothing to offer: still running, stopped, nothing tagged, the whole untagged set, started elsewhere, not tagging', () => {
    expect(tagNextSteps(tagJob({ progress: progress('running', 1) }))).toBeNull()
    expect(tagNextSteps(tagJob({ progress: progress('cancelled', 1) }))).toBeNull()
    expect(tagNextSteps(tagJob({ progress: progress('done', 0) }))).toBeNull()
    expect(tagNextSteps(tagJob({ ids: [] }))).toBeNull()
    expect(tagNextSteps(tagJob({ adopted: true }))).toBeNull()
    expect(tagNextSteps(tagJob({ kind: 'move' }))).toBeNull()
  })
})
