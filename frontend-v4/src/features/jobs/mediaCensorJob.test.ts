import { describe, expect, test } from 'vitest'
import { translate } from '../../i18n'
import { mediaCensorHeadline } from './mediaCensorHeadline'
import { readMediaCensor, sharePercent } from './mediaCensorJob'
import { contactChange, LOST_CONTACT_POLLS } from './mediaContact'
import type { JobProgress } from './progress'

const ctx = { jobId: 'abc', folder: 'D:/out' }
const base = (): JobProgress => ({
  status: 'running',
  current: 0,
  total: 100,
  unit: 'percent',
  succeeded: 0,
  failedCount: 0,
  failures: [],
  alreadyGone: 0,
  topTags: [],
  needsRestart: false,
  restartAdvised: false,
  toReview: 0,
  phase: null,
  updated: 0,
  currentItem: null,
  message: '',
})
const file = (name: string, status: string, over: Record<string, unknown> = {}) => ({
  name,
  status,
  frames_done: 0,
  frames_total: 0,
  censored_frames: 0,
  output: '',
  error: '',
  ...over,
})
const read = (raw: Record<string, unknown>, prev?: JobProgress) => readMediaCensor(base(), raw, ctx, prev)
const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params)
const headline = (progress: JobProgress, label = 'a.gif', count = 1) => mediaCensorHeadline({ label, count, progress }, en)

describe('sharePercent', () => {
  test('finished files plus the running one by its frames', () => {
    expect(sharePercent([file('a', 'done'), file('b', 'running', { frames_done: 5, frames_total: 10 }), file('c', 'queued'), file('d', 'queued')])).toBe(37)
    expect(sharePercent([])).toBe(0)
  })
})

describe('readMediaCensor', () => {
  test('a running job shows its share and the file it works on', () => {
    const p = read({ status: 'running', files: [file('a.gif', 'running', { frames_done: 3, frames_total: 6 })] })
    expect(p).toMatchObject({ status: 'running', unit: 'percent', total: 100, current: 50, currentItem: 'a.gif' })
  })

  test('a stop asked for stays "stopping" until the backend ends the job', () => {
    const prev = { ...base(), status: 'cancelling' as const }
    expect(read({ status: 'running', files: [file('a.gif', 'running')] }, prev).status).toBe('cancelling')
    expect(read({ status: 'cancelled', files: [file('a.gif', 'skipped')] }, prev).status).toBe('cancelled')
  })

  test('done counts finished files, the ones with nothing found, and the failed ones', () => {
    const p = read({
      status: 'done_with_errors',
      files: [file('a.gif', 'done', { censored_frames: 4, output: 'D:/out/a_censored.gif' }), file('b.gif', 'done'), file('c.mp4', 'error', { error: 'no ffmpeg' })],
    })
    expect(p).toMatchObject({ status: 'done', current: 100, succeeded: 2, failedCount: 1 })
    expect(p.media).toMatchObject({ untouched: 1, filesDone: 3, unreachable: false })
    expect(p.failures).toEqual([{ id: null, name: 'c.mp4', reason: 'no ffmpeg' }])
  })

  test('a job where every file failed is an error with the first reason', () => {
    const p = read({ status: 'done_with_errors', files: [file('a.mp4', 'error', { error: 'ffmpeg is missing' })] })
    expect(p).toMatchObject({ status: 'error', message: 'ffmpeg is missing' })
  })

  test('a job the backend no longer knows is lost, keeping what was seen', () => {
    const seen = read({ status: 'running', files: [file('a.gif', 'done'), file('b.gif', 'running')] })
    const gone = read({ gone: true }, seen)
    expect(gone).toMatchObject({ status: 'error', lost: true })
    expect(gone.media?.files).toHaveLength(2)
  })

  test('an unanswered look keeps the last reading and says contact is lost', () => {
    const seen = read({ status: 'running', files: [file('a.gif', 'running', { frames_done: 1, frames_total: 4 })] })
    const quiet = read({ unreachable: true }, seen)
    expect(quiet).toMatchObject({ status: 'running', current: 25 })
    expect(quiet.media?.unreachable).toBe(true)
    expect(read({ status: 'running', files: [file('a.gif', 'running')] }, quiet).media?.unreachable).toBe(false)
    // before the first answer there is nothing to keep, but the silence is still said
    expect(read({ unreachable: true }, base()).media).toMatchObject({ jobId: 'abc', unreachable: true, files: [] })
  })
})

describe('contactChange', () => {
  test('says it once at the fifth miss in a row, and once when contact is back', () => {
    let misses = 0
    const said: (string | null)[] = []
    for (let i = 0; i < LOST_CONTACT_POLLS + 2; i++) {
      const change = contactChange(misses, false)
      misses = change.next
      said.push(change.say)
    }
    expect(said.filter(Boolean)).toEqual(['lost'])
    expect(said.indexOf('lost')).toBe(LOST_CONTACT_POLLS - 1)
    expect(contactChange(misses, true)).toEqual({ next: 0, say: 'back' })
    expect(contactChange(2, true)).toEqual({ next: 0, say: null })
  })
})

describe('mediaCensorHeadline', () => {
  const done = (files: ReturnType<typeof file>[], status = 'done') => read({ status, files })

  test('running, stopping and a silent program', () => {
    const running = read({ status: 'running', files: [file('a.gif', 'running')] })
    expect(headline(running)).toBe('Censoring a.gif…')
    expect(headline({ ...running, status: 'cancelling' })).toBe('Censoring a.gif… · Stopping…')
    expect(headline({ ...running, media: running.media && { ...running.media, unreachable: true } })).toContain('lost contact with the program')
  })

  test('says what happened: covered, nothing found, mixed, failed', () => {
    expect(headline(done([file('a.gif', 'done', { censored_frames: 3 }), file('b.gif', 'done', { censored_frames: 1 })]), '2 files')).toBe('Censored 2 files. Saved in D:/out.')
    expect(headline(done([file('a.gif', 'done')]))).toBe('Nothing to cover was found in 1 file, so unchanged copies were saved in D:/out. Try a lower confidence or another detector.')
    expect(headline(done([file('a.gif', 'done', { censored_frames: 3 }), file('b.gif', 'done')]))).toBe(
      'Saved in D:/out. 1 file was covered; in 1 file nothing to cover was found, so they were saved unchanged.',
    )
    expect(headline(done([file('a.gif', 'done', { censored_frames: 3 }), file('b.mp4', 'error', { error: 'x' })], 'done_with_errors'))).toBe('Censored 1 file. Saved in D:/out. 1 file failed.')
  })

  test('a stop, a lost job and a failed job are each said as they are', () => {
    expect(headline(done([file('a.gif', 'done', { censored_frames: 1 }), file('b.gif', 'skipped')], 'cancelled'))).toBe('Stopped after 1 of 2 files. The finished ones are in D:/out.')
    expect(headline(done([file('a.gif', 'skipped')], 'cancelled'))).toBe('Stopped before any file was finished. Nothing was saved.')
    expect(headline(read({ gone: true }))).toContain('program was restarted')
    expect(headline(done([file('a.mp4', 'error', { error: 'ffmpeg is missing' })], 'done_with_errors'))).toBe('Could not censor: ffmpeg is missing')
  })
})
