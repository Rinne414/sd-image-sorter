import { describe, expect, test } from 'vitest'
import { explainBusy, isStaleLock } from './busyText'
import { zhCN } from '../../i18n/zh-CN'
import { en } from '../../i18n/en'

const fill = (template: string, params?: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (params?.[k] === undefined ? m : String(params[k])))
const tZh = (key: keyof typeof zhCN, params?: Record<string, string | number>) => fill(zhCN[key], params)
const tEn = (key: keyof typeof en, params?: Record<string, string | number>) => fill(en[key], params)

// main.py's AiRuntimeBusyError handler: the 409 body of a refused AI start.
const refused = (reason: string, blocker: Record<string, unknown> | null) => ({
  error: 'x',
  type: 'AiRuntimeBusyError',
  status_code: 409,
  reason,
  blocker,
  waited_seconds: 180,
})

describe('explainBusy', () => {
  test('a job inside the app: who, how long, and that it lets go by itself', () => {
    const body = refused('busy', { scope: 'thread', label: 'censor-onnx-inference', elapsed_seconds: 42, stuck: false })
    expect(explainBusy(body, tZh)).toBe('「打码检测 · YOLO」正在用 AI（已运行 42 秒）。它结束后会自动让出；也可以在它开始的地方停掉它。')
    expect(explainBusy(body, tEn)).toBe(
      'Censor detection · YOLO is using the AI (running for 42 s). It lets go by itself when it ends; you can also stop it where it was started.',
    )
  })

  test('a job inside the app that has held the AI too long is called stuck', () => {
    const body = refused('busy', { scope: 'thread', label: 'aesthetic', elapsed_seconds: 600, stuck: true })
    expect(explainBusy(body, tEn)).toBe(
      'Aesthetic scoring is using the AI (running for 10 min). It lets go by itself when it ends; you can also stop it where it was started. It has run for a long time and looks stuck; if nothing moves, restart the app.',
    )
  })

  test('another process: named, with the way to stop a tagging run started here', () => {
    const body = refused('busy', { scope: 'process', pid: 4242, label: 'tagger-load:wd-swinv2-tagger-v3', elapsed_seconds: 125, holder_alive: true })
    expect(explainBusy(body, tZh)).toBe(
      '另一个进程里的「打标签 · WD SwinV2 v3（加载模型）」正在用 AI（已运行 2 分钟）。等它结束再试；如果是这里开始的打标签，可以在「工作」里停掉它。',
    )
  })

  test('another process that did not name itself', () => {
    expect(explainBusy(refused('busy', null), tEn)).toBe(
      'Another process is using the AI and did not say what it is. Only one AI job runs at a time: try again when it ends.',
    )
    expect(explainBusy(refused('busy', { scope: 'process', label: null, elapsed_seconds: null }), tZh)).toBe(
      '另一个进程正在用 AI，没说是什么。同一时间只能跑一个 AI 工作，等它结束再试。',
    )
  })

  test('a lock whose job is gone: restart, not wait', () => {
    const named = refused('stale_lock_holder_gone', { scope: 'process', pid: 9, label: 'wd14-tagger', elapsed_seconds: 9000, holder_alive: false })
    expect(explainBusy(named, tZh)).toBe('AI 还被锁着，但锁住它的「打标签」已经不在运行了。等也不会好，重启程序才能解开。')
    expect(explainBusy(refused('stale_lock_holder_gone', null), tEn)).toBe(
      'The AI is still locked by a job that is no longer running. Waiting will not help: restart the app to clear it.',
    )
  })

  test('a 409 that is not about the AI is left to the caller (a queue of the same kind is busy)', () => {
    expect(explainBusy({ detail: 'Tagging already in progress' }, tEn)).toBeNull()
    expect(explainBusy(null, tEn)).toBeNull()
  })
})

describe('a lock whose holder is gone', () => {
  test('is told apart from a busy AI, so the refusal can offer a restart', () => {
    expect(isStaleLock({ body: refused('stale_lock_holder_gone', { label: 'wd14-tagger-load' }) })).toBe(true)
    expect(isStaleLock({ body: refused('busy', { label: 'aesthetic' }) })).toBe(false)
    expect(isStaleLock({ body: { error: 'x' } })).toBe(false)
    expect(isStaleLock(new Error('x'))).toBe(false)
  })
})
