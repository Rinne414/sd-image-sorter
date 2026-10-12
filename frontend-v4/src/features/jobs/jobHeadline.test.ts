import { describe, expect, test } from 'vitest'
import { useLang } from '../../i18n'
import { jobHeadline } from './headline'
import type { Job } from './jobs'
import type { JobProgress } from './progress'

const done = (fields: Partial<JobProgress> = {}): JobProgress => ({
  status: 'done', current: 1, total: 1, unit: 'bytes', succeeded: 1, failedCount: 0, failures: [], alreadyGone: 0,
  topTags: [], needsRestart: false, restartAdvised: false, toReview: 0, phase: null, updated: 0, currentItem: null, message: '',
  ...fields,
})

const install = (progress: JobProgress): Job => ({
  id: 'install-1', kind: 'install', count: 0, destination: null, ids: [], adopted: false, pollErrors: 0, ctx: {}, label: 'ToriiGate', progress,
})

describe('an install that ended', () => {
  test('ready to use: it says so', () => {
    useLang.setState({ lang: 'en' })
    expect(jobHeadline(install(done()))).toBe('ToriiGate is ready')
  })

  test('installed but usable only after a restart: it says that, never "is ready"', () => {
    useLang.setState({ lang: 'en' })
    expect(jobHeadline(install(done({ needsRestart: true })))).toBe('ToriiGate is installed; restart the app to use it')
    useLang.setState({ lang: 'zh-CN' })
    expect(jobHeadline(install(done({ needsRestart: true })))).toBe('ToriiGate 装好了，要重启程序才能用')
  })
})

describe('a queued Smart Tag run the backend no longer knows', () => {
  const lost = (): Job => ({
    id: 'smarttag-1', kind: 'smarttag', count: 4, destination: null, ids: [], adopted: false, pollErrors: 0, ctx: { smartTag: { queueId: 'q9' } }, label: null,
    progress: done({ status: 'error', current: 0, total: 0, succeeded: 0, unit: 'images', lost: true }),
  })

  test('says how it ended is unknown and to run the step again, never a made-up error', () => {
    useLang.setState({ lang: 'en' })
    expect(jobHeadline(lost())).toBe("4 images: we couldn't find how this run ended (the app may have restarted since). Run the batch's AI tagging step again.")
    useLang.setState({ lang: 'zh-CN' })
    expect(jobHeadline(lost())).toBe('4 张：找不到这次运行是怎么结束的（程序可能中途重启过）。请在批次里再运行一次「AI 打标」这一步。')
  })
})

describe('a move into a library folder listed with forward slashes (L:/…)', () => {
  const moved = (destination: string): Job => ({
    id: 'move-1', kind: 'move', count: 3, destination, ids: [], adopted: false, pollErrors: 0, ctx: {}, label: null, progress: done({ succeeded: 3, unit: 'images' }),
  })

  test('names the end of the folder, split on its own separator', () => {
    useLang.setState({ lang: 'en' })
    expect(jobHeadline(moved('L:/Pictures/AAA Reference/AAAwith prompt/NSFW/keep'))).toBe('Moved 3 to …/AAA Reference/AAAwith prompt/NSFW/keep')
    expect(jobHeadline(moved('L:\\Pictures\\AAA Reference\\AAAwith prompt\\NSFW\\keep'))).toBe('Moved 3 to …\\AAA Reference\\AAAwith prompt\\NSFW\\keep')
  })
})
