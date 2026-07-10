/**
 * Click-ledger test base (coverage ledger, Phase 2).
 *
 * Every spec imports { test, expect } from this module instead of
 * '@playwright/test'. The extended `context` fixture:
 *   1. injects fixtures/control-key.js (window.__controlKey/__controlContext),
 *   2. installs a capture-phase document click listener in every document,
 *   3. streams each click to Node via exposeBinding (survives navigations),
 *   4. appends the per-test click log to artifacts/click-coverage/*.jsonl.
 *
 * scripts/coverage_gate.py merges the JSONL files with the control inventory
 * (written by specs/zz-coverage-crawl.spec.ts) into the coverage ratchet.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test as base } from '@playwright/test'

const ARTIFACT_DIR = path.resolve(__dirname, '..', '..', '..', 'artifacts', 'click-coverage')
const CONTROL_KEY_SCRIPT = path.join(__dirname, 'control-key.js')

interface LedgerEntry {
    key: string
    context: string
}

export * from '@playwright/test'

export const test = base.extend({
    context: async ({ context }, use, testInfo) => {
        const entries: LedgerEntry[] = []
        await context.exposeBinding('__pwLedgerRecord', (_source, entry: LedgerEntry) => {
            if (entry && typeof entry.key === 'string') entries.push(entry)
        })
        await context.addInitScript({ path: CONTROL_KEY_SCRIPT })
        await context.addInitScript(() => {
            const w = window as unknown as {
                __pwLedgerBound?: boolean
                __controlKey?: (el: Element | null) => string | null
                __controlContext?: () => string
                __pwLedgerRecord?: (entry: { key: string, context: string }) => void
            }
            if (w.__pwLedgerBound) return
            w.__pwLedgerBound = true
            document.addEventListener('click', (event) => {
                try {
                    const key = w.__controlKey ? w.__controlKey(event.target as Element | null) : null
                    if (!key || !w.__pwLedgerRecord) return
                    w.__pwLedgerRecord({ key, context: w.__controlContext ? w.__controlContext() : 'unknown' })
                } catch {
                    // The ledger must never break the app under test.
                }
            }, true)
        })

        await use(context)

        if (entries.length) {
            fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
            const file = path.join(ARTIFACT_DIR, `raw-worker-${testInfo.workerIndex}.jsonl`)
            const testId = testInfo.titlePath.join(' › ')
            const lines = entries.map((entry) => JSON.stringify({ test: testId, ...entry }))
            fs.appendFileSync(file, `${lines.join('\n')}\n`)
        }
    },
})
