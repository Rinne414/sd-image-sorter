/**
 * Coverage crawl (Phase 2 of the QA coverage ledger).
 *
 * 1. Control inventory — walk every view, snapshot every interactive control
 *    (button / [role=button] / input / select / textarea) with the same
 *    window.__controlKey identity the click ledger uses
 *    → artifacts/control-inventory.json
 * 2. Click crawl — mechanically click every *safe* button per view (and one
 *    level into any modal a click opens), asserting the app survives:
 *    no console errors, no uncaught exceptions, no 4xx/5xx responses.
 *    External-side-effect buttons are denylisted (scan/tag/model downloads,
 *    file-system, destructive ops).
 * 3. JS coverage — V8 coverage for the crawl session; functions never
 *    executed → artifacts/js-coverage-unused.json (advisory, not gated).
 *
 * scripts/coverage_gate.py turns (inventory − clicked) into the ratcheted
 * untested-controls report after the whole suite has contributed clicks.
 *
 * Named zz-* so it runs last: by then the shared e2e library is populated,
 * which exposes the maximum number of controls.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '../fixtures/click-ledger'

const ARTIFACTS_DIR = path.resolve(__dirname, '..', '..', '..', 'artifacts')

// Buttons the crawl must NOT press. Matched against the synthesized control
// key (lowercased). Keep in sync with the waiver rationale in
// tests/e2e/coverage-baseline.json.
const DENY_PATTERNS: RegExp[] = [
    // Destructive / data-mutating
    /trash|delete|remove|clear|reset|danger|discard|cull-btn|revert/,
    // Long-running background jobs and model downloads
    /start-scan|start-tag|start-sorting|start-sort|btn-start|prepare|download|install|identify|embed|backfill|repair|generate|analyz|caption|score/,
    // App/system side effects
    /shutdown|restart|update|open-folder|manage-roots|reveal|logs?[-_]open|support/,
    // File-system writes and pickers
    /export|save|import|upload|browse|file|move|copy|rename|publish|apply/,
    // Session-stateful flows other specs depend on
    /sort-session|resume|solitaire/,
    // Reversible but crawl-hostile (flips every i18n key mid-run)
    /language-toggle/,
]

interface ControlRecord {
    key: string
    context: string
    tag: string
    disabled: boolean
    visible: boolean
}

function isDenied(key: string): boolean {
    const lower = key.toLowerCase()
    return DENY_PATTERNS.some((re) => re.test(lower))
}

async function snapshotControls(page: Page): Promise<ControlRecord[]> {
    return page.evaluate(() => {
        const w = window as unknown as {
            __controlKey: (el: Element) => string | null
            __controlContext: () => string
        }
        const els = [...document.querySelectorAll('button, [role="button"], input, select, textarea')]
        const records: Array<{ key: string, context: string, tag: string, disabled: boolean, visible: boolean }> = []
        const seen = new Set<string>()
        const context = w.__controlContext()
        for (const el of els) {
            const rect = el.getBoundingClientRect()
            const style = getComputedStyle(el)
            const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
            if (!visible) continue
            const key = w.__controlKey(el)
            if (!key || seen.has(key)) continue
            seen.add(key)
            records.push({
                key,
                context,
                tag: el.tagName.toLowerCase(),
                disabled: (el as HTMLButtonElement).disabled === true,
                visible,
            })
        }
        return records
    })
}

async function closeAnyModal(page: Page): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
        const openModal = await page.evaluate(() => {
            const modal = [...document.querySelectorAll('.modal[id]')].find((m) => {
                const style = getComputedStyle(m)
                return (m.classList.contains('visible') || style.display !== 'none') && style.visibility !== 'hidden'
            })
            return modal ? modal.id : null
        })
        if (!openModal) return
        await page.keyboard.press('Escape')
        await page.waitForTimeout(250)
    }
}

async function activeSurface(page: Page): Promise<string> {
    return page.evaluate(() => (window as unknown as { __controlContext: () => string }).__controlContext())
}

test.describe('coverage crawl', () => {
    test('inventory + mechanical click crawl survives without errors', async ({ page }) => {
        test.setTimeout(900_000)

        const consoleErrors: string[] = []
        const pageErrors: string[] = []
        const badResponses: string[] = []
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300))
        })
        page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 300)))
        page.on('response', (res) => {
            if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url().slice(0, 200)}`)
        })

        await page.coverage.startJSCoverage({ resetOnNavigation: false })
        await page.goto('/')
        await page.waitForLoadState('networkidle')
        await page.waitForTimeout(1000)

        // Views are a mix of <section> and <div> hosts — match on class+id.
        const viewNames: string[] = await page.evaluate(() =>
            [...document.querySelectorAll('.view[id^="view-"]')].map((el) => el.id.replace(/^view-/, ''))
        )
        expect(viewNames.length).toBeGreaterThan(3)

        const inventory = new Map<string, ControlRecord>()
        let clickedCount = 0

        const recordInventory = (records: ControlRecord[]) => {
            for (const record of records) {
                if (!inventory.has(record.key)) inventory.set(record.key, record)
            }
        }

        // Crawl the buttons currently visible on the given surface. When a
        // click opens a modal, inventory the modal and crawl one level of its
        // buttons, then close it. Depth is capped at 1 modal level.
        const crawlSurface = async (surface: string, depth: number): Promise<void> => {
            const clickedHere = new Set<string>()
            // Re-enumerate after every click: the DOM may re-render.
            for (let round = 0; round < 200; round += 1) {
                const records = await snapshotControls(page)
                recordInventory(records)
                const candidate = records.find((record) =>
                    !record.disabled
                    && (record.tag === 'button' || record.key.includes('[role='))
                    && record.tag !== 'input' && record.tag !== 'select' && record.tag !== 'textarea'
                    && !clickedHere.has(record.key)
                    && !isDenied(record.key))
                if (!candidate) break
                clickedHere.add(candidate.key)

                const clicked = await page.evaluate((key) => {
                    const w = window as unknown as { __controlKey: (el: Element) => string | null }
                    const els = [...document.querySelectorAll('button, [role="button"]')]
                    const el = els.find((node) => w.__controlKey(node) === key) as HTMLElement | undefined
                    if (!el) return false
                    el.click()
                    return true
                }, candidate.key).catch(() => false)
                if (!clicked) continue
                clickedCount += 1
                await page.waitForTimeout(150)

                const now = await activeSurface(page)
                if (now.startsWith('modal:') && depth === 0) {
                    await crawlSurface(now, 1)
                    await closeAnyModal(page)
                } else if (now.startsWith('modal:')) {
                    // Nested modal: inventory it but do not descend further.
                    recordInventory(await snapshotControls(page))
                    await closeAnyModal(page)
                } else if (depth === 0 && now !== surface) {
                    // The click navigated away (nav buttons, mission tiles…).
                    // Record where we landed, then come back.
                    recordInventory(await snapshotControls(page))
                    const viewName = surface.replace(/^view:/, '')
                    await page.evaluate((name) => {
                        const w = window as unknown as { App?: { switchView?: (v: string) => void } }
                        w.App?.switchView?.(name)
                    }, viewName)
                    await page.waitForTimeout(300)
                }
                if (depth === 1 && !now.startsWith('modal:')) return // modal closed itself
            }
        }

        for (const viewName of viewNames) {
            await page.evaluate((name) => {
                const w = window as unknown as { App?: { switchView?: (v: string) => void } }
                w.App?.switchView?.(name)
            }, viewName)
            await page.waitForTimeout(600)
            const surface = await activeSurface(page)
            if (surface !== `view:${viewName}`) continue // view refused to activate (guarded)
            await crawlSurface(surface, 0)
            await closeAnyModal(page)
        }

        // ---- write artifacts -------------------------------------------------
        fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
        const inventoryList = [...inventory.values()]
        fs.writeFileSync(
            path.join(ARTIFACTS_DIR, 'control-inventory.json'),
            JSON.stringify({
                generatedAt: new Date().toISOString(),
                views: viewNames,
                clickedByCrawl: clickedCount,
                controls: inventoryList,
            }, null, 2)
        )

        const coverageEntries = await page.coverage.stopJSCoverage()
        const unused: Array<{ file: string, functionName: string }> = []
        for (const entry of coverageEntries) {
            if (!/\/js\/.+\.js/.test(entry.url)) continue
            const file = entry.url.replace(/^.*?\/(js\/.*?\.js).*$/, '$1')
            for (const fn of entry.functions || []) {
                if (!fn.functionName) continue
                if ((fn.ranges || []).every((range) => range.count === 0)) {
                    unused.push({ file, functionName: fn.functionName })
                }
            }
        }
        fs.writeFileSync(
            path.join(ARTIFACTS_DIR, 'js-coverage-unused.json'),
            JSON.stringify({
                generatedAt: new Date().toISOString(),
                note: 'Functions never executed during the coverage crawl session (advisory).',
                count: unused.length,
                functions: unused,
            }, null, 2)
        )

        // ---- the actual gate: the app survived the mechanical crawl ----------
        expect(inventoryList.length).toBeGreaterThan(50)
        expect(clickedCount).toBeGreaterThan(20)
        expect(pageErrors, `uncaught exceptions during crawl:\n${pageErrors.join('\n')}`).toEqual([])
        expect(consoleErrors, `console errors during crawl:\n${consoleErrors.join('\n')}`).toEqual([])
        expect(badResponses, `4xx/5xx during crawl:\n${badResponses.join('\n')}`).toEqual([])
    })
})
