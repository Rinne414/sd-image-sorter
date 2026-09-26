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
