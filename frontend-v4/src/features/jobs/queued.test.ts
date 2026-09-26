import { describe, expect, test } from 'vitest'
import { en } from '../../i18n/en'
import { zhCN } from '../../i18n/zh-CN'
import { queuedKey } from './queued'

describe('what a queued job says it waits for', () => {
  test('only tagging runs wait for the tagging run before them', () => {
    expect(queuedKey('tag')).toBe('jobs.queued')
    expect(queuedKey('smarttag')).toBe('jobs.queued')
  })

  test('bulk jobs (masks, duplicate scan, metadata repair) never mention tagging', () => {
    for (const kind of ['masks', 'dupscan', 'reparse', 'reread'] as const) {
      expect(zhCN[queuedKey(kind)]).not.toContain('打标签')
      expect(en[queuedKey(kind)]).not.toMatch(/tagging/i)
    }
  })
})
