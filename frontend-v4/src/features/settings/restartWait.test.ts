import { describe, expect, test } from 'vitest'
import { zhCN } from '../../i18n/zh-CN'
import { en } from '../../i18n/en'
import { busyJobsText, RESTART_WAIT_MS, waitForNewBoot, type BootDeps } from './restartWait'

/** A fake clock: sleep moves time on; each look at the server answers from `answers` (the last one repeats). */
function fakeServer(answers: (string | null | Error)[]): BootDeps & { looks: number; elapsed: () => number } {
  let now = 0
  const state = {
    looks: 0,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    },
    fetchBootId: async () => {
      const answer = answers[Math.min(state.looks, answers.length - 1)]!
      state.looks += 1
      if (answer instanceof Error) throw answer
      return answer
    },
    elapsed: () => now,
  }
  return state
}

describe('waitForNewBoot', () => {
  test('reloads once the server answers with another boot id', async () => {
    const server = fakeServer(['old', new Error('down'), new Error('down'), 'new'])
    expect(await waitForNewBoot('old', server)).toBe(true)
    expect(server.looks).toBe(4)
  })

  test('the same id means the old server is still up: keep waiting', async () => {
    const server = fakeServer(['old', 'old', 'next'])
    expect(await waitForNewBoot('old', server)).toBe(true)
    expect(server.looks).toBe(3)
  })

  test('gives up after three minutes without a new server', async () => {
    const server = fakeServer([new Error('down')])
    expect(await waitForNewBoot('old', server)).toBe(false)
    expect(RESTART_WAIT_MS).toBe(180_000)
    expect(server.elapsed()).toBeGreaterThanOrEqual(RESTART_WAIT_MS)
    expect(server.elapsed()).toBeLessThan(RESTART_WAIT_MS + 2_000)
  })

  test('without the old id it waits until the server went away and came back', async () => {
    const server = fakeServer(['same', 'same', new Error('down'), 'back'])
    expect(await waitForNewBoot(null, server)).toBe(true)
    expect(server.looks).toBe(4)
  })
})

describe('busyJobsText', () => {
  const zh = (key: keyof typeof zhCN) => zhCN[key]
  const english = (key: keyof typeof en) => en[key]

  test('names each running job once, in plain words', () => {
    expect(busyJobsText(['scan', 'tagging', 'file_moves'], zh, 'zh-CN')).toBe('文件夹扫描、打标签、移动文件')
    expect(busyJobsText(['model_setup', 'captions'], english, 'en')).toBe('a model download, writing captions')
  })

  test('unknown ids read as a background task, listed once', () => {
    expect(busyJobsText(['mystery', 'background_jobs', 'ai'], english, 'en')).toBe('a background task, AI work')
    expect(busyJobsText('not a list', english, 'en')).toBe('')
  })
})
