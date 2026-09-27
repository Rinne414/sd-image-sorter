/**
 * Click-ledger test base (docs/COVERAGE_LEDGER.md).
 *
 * Every spec imports { test, expect } from this module instead of
 * '@playwright/test'. The extended `context` fixture:
 *   1. injects fixtures/control-key.js (window.__controlKey / __controlContext /
 *      __controlsInView),
 *   2. records every control a test used (click, or a change/input on a field)
 *      as a "used" row, and every control that was on screen shortly after an
 *      action, after a page load and when the test ends as a "seen" row,
 *   3. streams the rows to Node through exposeBinding (survives navigations),
 *   4. appends the test's rows to artifacts/click-coverage/raw-*.jsonl.
 *
 * scripts/coverage_gate.py turns the rows into the coverage ratchet: of the
 * controls the suite showed, how many did it use.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test as base } from '@playwright/test'

const DEFAULT_ARTIFACT_ROOT = path.resolve(__dirname, '..', '..', '..', 'artifacts')
const ARTIFACT_ROOT = process.env.PW_RUN_ARTIFACT_DIR
  ? path.resolve(process.env.PW_RUN_ARTIFACT_DIR)
  : DEFAULT_ARTIFACT_ROOT
const ARTIFACT_DIR = path.join(ARTIFACT_ROOT, 'click-coverage')
const SHARD_INDEX = process.env.PW_SHARD_INDEX || ''
if (SHARD_INDEX && !/^[1-9]\d*$/.test(SHARD_INDEX)) {
  throw new Error(`PW_SHARD_INDEX must be a positive integer when set, received ${SHARD_INDEX}`)
}
const CONTROL_KEY_SCRIPT = path.join(__dirname, 'control-key.js')
const FINAL_SNAPSHOT_TIMEOUT_MS = 1500

type Kind = 'used' | 'seen'

interface LedgerEntry {
  kind: Kind
  key: string
  context: string
}

interface LedgerWindow {
  __pwLedgerBound?: boolean
  __controlKey?: (el: Element | null) => string | null
  __controlContext?: (el: Element | null) => string
  __controlsInView?: () => { key: string; context: string }[]
  __pwLedgerRecord?: (entries: LedgerEntry[]) => void
}

export * from '@playwright/test'

export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    const rows = new Map<string, LedgerEntry>()
    const add = (entry: LedgerEntry) => {
      if (!entry || typeof entry.key !== 'string' || !entry.key) return
      const id = `${entry.kind}\u0000${entry.key}`
      if (!rows.has(id)) rows.set(id, { kind: entry.kind === 'used' ? 'used' : 'seen', key: entry.key, context: String(entry.context || 'unknown') })
    }
    await context.exposeBinding('__pwLedgerRecord', (_source, entries: LedgerEntry[]) => {
      if (Array.isArray(entries)) for (const entry of entries) add(entry)
    })
    await context.addInitScript({ path: CONTROL_KEY_SCRIPT })
    await context.addInitScript(() => {
      const w = window as unknown as LedgerWindow
      if (w.__pwLedgerBound) return
      w.__pwLedgerBound = true
      const sent = new Set<string>()
      let timer = 0
      const send = (entries: { kind: 'used' | 'seen'; key: string; context: string }[]) => {
        const fresh = entries.filter((e) => {
          const id = `${e.kind}\u0000${e.key}`
          if (sent.has(id)) return false
          sent.add(id)
          return true
        })
        if (fresh.length && w.__pwLedgerRecord) w.__pwLedgerRecord(fresh)
      }
      const snapshot = () => {
        timer = 0
        try {
          send((w.__controlsInView ? w.__controlsInView() : []).map((c) => ({ kind: 'seen' as const, ...c })))
        } catch {
          // The ledger must never break the app under test.
        }
      }
      // What an action opened (a dialog, a menu) is on screen a moment later.
      const soon = () => {
        if (timer) window.clearTimeout(timer)
        timer = window.setTimeout(snapshot, 250)
      }
      const used = (event: Event) => {
        try {
          const target = event.target as Element | null
          const key = w.__controlKey ? w.__controlKey(target) : null
          if (key) send([{ kind: 'used', key, context: w.__controlContext ? w.__controlContext(target) : 'unknown' }])
          soon()
        } catch {
          // The ledger must never break the app under test.
        }
      }
      document.addEventListener('click', used, true)
      document.addEventListener('change', used, true)
      document.addEventListener('input', used, true)
      window.addEventListener('load', () => window.setTimeout(snapshot, 500))
    })

    await use(context)

    // Whatever is on screen when the test ends was seen too.
    for (const page of context.pages()) {
      if (page.isClosed()) continue
      try {
        const now = await Promise.race([
          page.evaluate(() => {
            const w = window as unknown as LedgerWindow
            return w.__controlsInView ? w.__controlsInView() : []
          }),
          new Promise<{ key: string; context: string }[]>((resolve) => setTimeout(() => resolve([]), FINAL_SNAPSHOT_TIMEOUT_MS)),
        ])
        for (const c of now) add({ kind: 'seen', ...c })
      } catch {
        // A page that navigated away or crashed has nothing more to add.
      }
    }

    if (rows.size) {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
      const shardSegment = SHARD_INDEX ? `shard-${SHARD_INDEX}-` : ''
      const file = path.join(ARTIFACT_DIR, `raw-${shardSegment}worker-${testInfo.workerIndex}.jsonl`)
      const testId = testInfo.titlePath.join(' › ')
      const lines = [...rows.values()].map((entry) => JSON.stringify({ test: testId, ...entry }))
      fs.appendFileSync(file, `${lines.join('\n')}\n`)
    }
  },
})
