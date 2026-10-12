import { describe, expect, test } from 'vitest'
import { zhCN } from '../../i18n/zh-CN'
import { en } from '../../i18n/en'
import { askKeys, askWhenBusy, busyJobs, busyJobsText, RESTART_WAIT_MS, waitForNewBoot, type BootDeps } from './restartWait'

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

describe('busyJobs', () => {
  test('a busy answer from /restart or /apply gives its job ids', () => {
    expect(busyJobs({ status: 'busy', jobs: ['scan', 'tagging'], boot_id: 'boot-A' })).toEqual(['scan', 'tagging'])
    expect(busyJobs({ status: 'busy', jobs: [7] })).toEqual(['7'])
  })

  test('busy without a job list still counts as busy', () => {
    expect(busyJobs({ status: 'busy' })).toEqual([])
    expect(busyJobs({ status: 'busy', jobs: 'scan' })).toEqual([])
  })

  test('any other answer is not busy', () => {
    expect(busyJobs({ status: 'scheduled', boot_id: 'boot-A' })).toBeNull()
    expect(busyJobs({ status: 'up_to_date' })).toBeNull()
    expect(busyJobs(null)).toBeNull()
    expect(busyJobs('busy')).toBeNull()
  })
})

describe('askWhenBusy', () => {
  /** A server that answers in turn (the last one repeats) and remembers each check flag it was sent. */
  function fakeSend(answers: unknown[]) {
    const sent: boolean[] = []
    const send = async (check: boolean) => {
      sent.push(check)
      return answers[Math.min(sent.length - 1, answers.length - 1)]
    }
    return { sent, send }
  }

  test('nothing running: one request with the check on, nobody is asked', async () => {
    const server = fakeSend([{ status: 'scheduled' }])
    const asked: string[][] = []
    const result = await askWhenBusy(server.send, async (jobs) => (asked.push(jobs), true))
    expect(result).toEqual({ status: 'scheduled' })
    expect(server.sent).toEqual([true])
    expect(asked).toEqual([])
  })

  test('busy and the user goes ahead: the same request again with the check off', async () => {
    const server = fakeSend([{ status: 'busy', jobs: ['scan', 'model_setup'] }, { status: 'scheduled' }])
    const asked: string[][] = []
    const result = await askWhenBusy(server.send, async (jobs) => (asked.push(jobs), true))
    expect(asked).toEqual([['scan', 'model_setup']])
    expect(server.sent).toEqual([true, false])
    expect(result).toEqual({ status: 'scheduled' })
  })

  test('busy and the user cancels: nothing more is sent', async () => {
    const server = fakeSend([{ status: 'busy', jobs: ['tagging'] }])
    const result = await askWhenBusy(server.send, async () => false)
    expect(result).toBeNull()
    expect(server.sent).toEqual([true])
  })
})

describe('askKeys', () => {
  const fill = (template: string, params: Record<string, string>) => template.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m)

  test('an install while jobs run names them, in the restart question’s words', () => {
    const keys = askKeys('install', true)
    const zhJobs = busyJobsText(['scan', 'model_setup'], (key) => zhCN[key], 'zh-CN')
    expect(zhCN[keys.title]).toBe('现在安装吗？')
    expect(fill(zhCN[keys.body], { jobs: zhJobs })).toBe('还在进行：文件夹扫描、模型下载。安装会中断它，装好后可以再开始。')
    expect(zhCN[keys.ok]).toBe('仍要安装')
    const enJobs = busyJobsText(['scan', 'model_setup'], (key) => en[key], 'en')
    expect(en[keys.title]).toBe('Install now?')
    expect(fill(en[keys.body], { jobs: enJobs })).toBe('Still running: a folder scan, a model download. Installing stops it; you can start it again afterwards.')
    expect(en[keys.ok]).toBe('Install anyway')
  })

  test('a restart keeps its own words, with or without running jobs', () => {
    expect(askKeys('restart', true)).toEqual({ title: 'restart.busy.title', body: 'restart.busy.body', ok: 'restart.busy.ok' })
    expect(askKeys('restart', false)).toEqual({ title: 'restart.ask.title', body: 'restart.ask.body', ok: 'restart.ask.ok' })
  })
})
