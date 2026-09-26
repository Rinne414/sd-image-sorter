import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, openLibrary, runBackendScript, seedImages, tmpRoot } from '../fixtures/v4-seed'

/**
 * V4 library status, each row with its fix, on the real backend: images whose
 * generation details failed to read are read again, missing text is
 * recovered (and the offer steps back once a run has tried), and the full
 * report shows the score, what to do next and the files to check. A move
 * stuck while stopping offers the reset (stubbed).
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4lstoken'
const PREFIX = 'v4ls-'
const COUNT = 6
const DIR = 'v4-ls'
const SERVER = `http://127.0.0.1:${process.env.PW_WEB_SERVER_PORT || process.env.SD_IMAGE_SORTER_PORT || '19087'}`

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  fs.rmSync(path.join(tmpRoot, DIR, `${PREFIX}03.png`))
  // 00 and 01 opened but their details failed; 02 has no text; 03's file is gone.
  // A throwaway row removed through the API makes the server drop its cached report.
  runBackendScript(`
import json, sqlite3, urllib.request
p = ${JSON.stringify(PREFIX)}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("UPDATE images SET metadata_status = 'error', read_error = 'bad chunk' WHERE filename IN (?, ?)", (p + "00.png", p + "01.png"))
    conn.execute("UPDATE images SET prompt = NULL, sidecar_caption = NULL WHERE filename = ?", (p + "02.png",))
    conn.execute("UPDATE images SET is_readable = 0, metadata_status = 'error', read_error = 'File not found' WHERE filename = ?", (p + "03.png",))
    cur = conn.execute("INSERT INTO images (path, filename, is_readable, metadata_status) VALUES ('x', ?, 1, 'complete')", (p + "sentinel.png",))
    sentinel = cur.lastrowid
    conn.commit()
req = urllib.request.Request(${JSON.stringify(SERVER)} + "/api/images/remove-selected",
    data=json.dumps({"image_ids": [sentinel], "background": False}).encode(),
    headers={"Content-Type": "application/json", "X-SD-Library-Id": "main"}, method="POST")
urllib.request.urlopen(req, timeout=15).read()
print("ok")
`)
})

test.afterAll(() => cleanupImages(PREFIX, [DIR]))

const drawerJobs = (page: Page) => page.getByTestId('jobs-drawer').getByTestId('job')

test('read errors are read again and missing text is recovered, each from its row', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT - 1)

  const status = page.getByTestId('library-status')
  await expect(status).toContainText('1 file not found')
  await expect(status).toContainText("2 with metadata that couldn't be read")
  await expect(status).toContainText('1 with no prompt and no caption')

  // Read the two failed files again: their details now read, so the row goes away.
  await status.getByRole('button', { name: 'Read again' }).click()
  await expect(status).not.toContainText("metadata that couldn't be read", { timeout: 20_000 })
  await page.getByTestId('jobs-button').click()
  await expect(drawerJobs(page).first()).toContainText('Read again: 2 now read fine')
  await page.keyboard.press('Escape')

  // Plain PNGs carry no text, so after the re-read three images have none.
  await expect(status).toContainText('3 with no prompt and no caption', { timeout: 20_000 })
  await status.getByRole('button', { name: 'Recover text' }).click()
  // Nothing could be found; the offer steps back instead of staying forever.
  await expect(status).not.toContainText('with no prompt and no caption', { timeout: 20_000 })
  await page.getByTestId('jobs-button').click()
  await expect(drawerJobs(page).first()).toContainText('Text recovery done: 0 got a prompt or caption back')
  await page.keyboard.press('Escape')

  // The full report still lists them, with the fix beside the count.
  await status.getByTestId('status-report-open').click()
  const report = page.getByTestId('library-report')
  await expect(report).toBeInViewport()
  await expect(report.getByTestId('report-score')).toHaveText(/^\d+$/)
  const next = report.getByTestId('report-next')
  await expect(next.locator('[data-step="missingText"]')).toContainText('3 images have neither a prompt nor a caption')
  await expect(next.locator('[data-step="missingText"]').getByRole('button', { name: 'Recover text' })).toBeEnabled()
  await expect(next.locator('[data-step="missing"]')).toContainText('1 image cannot be read')
  await expect(report.getByTestId('report-samples')).toContainText(`${PREFIX}03.png`)
  await expect(report.getByTestId('report-breakdown')).toContainText('No prompt and no caption')

  // Its missing-files fix leads to the missing-files dialog.
  await next.locator('[data-step="missing"]').getByRole('button', { name: 'Deal with it…' }).click()
  await expect(report).toHaveCount(0)
  await expect(page.getByTestId('missing-dialog')).toContainText(DIR)
})

// The repairs read 00, 01 and 02 from their files, which carry no prompt, so the token no longer finds them.
const AFTER_REREAD = COUNT - 4

test('a file to check opens on the card; Ctrl K opens the report too', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, TOKEN, AFTER_REREAD)

  await page.keyboard.press('Control+k')
  await page.keyboard.type('library report')
  await page.keyboard.press('Enter')
  const report = page.getByTestId('library-report')
  const row = report.getByTestId('report-samples').locator('li', { hasText: `${PREFIX}02.png` })
  await row.getByRole('button', { name: 'Look at it' }).click()
  await expect(report).toHaveCount(0)
  await expect(page.getByTestId('generation-card')).toContainText(`${PREFIX}02.png`)
})

test('a move stuck while stopping can be reset, and a refusal says it is still running', async ({ page }) => {
  test.setTimeout(90_000)
  let resets = 0
  let cleared = false
  await page.route('**/api/move/progress', (route) =>
    route.fulfill({
      json: cleared
        ? { status: 'idle', current: 0, total: 0, moved: 0, errors: 0 }
        : { status: 'cancelling', operation: 'move', current: 1, total: 3, moved: 1, errors: 0, current_item: 'a.png' },
    }),
  )
  await page.route('**/api/move/reset', (route) => {
    resets += 1
    if (resets === 1) return route.fulfill({ status: 409, json: { detail: 'Cannot reset move while it is still running' } })
    cleared = true
    return route.fulfill({ json: { status: 'reset', message: 'Move progress reset to idle' } })
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, AFTER_REREAD)

  await page.getByTestId('jobs-button').click()
  const job = drawerJobs(page).first()
  await expect(job).toContainText('Stopping')
  // Not offered at once: a live worker needs time to reach its next image.
  await expect(job.getByTestId('job-stuck')).toHaveCount(0)
  await expect(job.getByTestId('job-stuck')).toBeVisible({ timeout: 25_000 })

  await job.getByRole('button', { name: 'Reset stuck job' }).click()
  await expect(page.getByText('That job is still running. Try again once it ends.')).toBeVisible()
  await job.getByRole('button', { name: 'Reset stuck job' }).click()
  await expect(job).toContainText('This job was reset', { timeout: 10_000 })
  expect(resets).toBe(2)
})

// ---- Imports: a stall, the next steps, tagging afterwards; missing files ----

interface ImportStub {
  started: boolean
  finished: boolean
  final: Record<string, unknown>
}

/** A stubbed import: stalled while running, `final` once finished. */
async function stubImport(page: Page, run: ImportStub) {
  const base = { run_id: 91, source: 'manual', total_final: true, import_complete: true }
  await page.route('**/api/scan', (route) => {
    run.started = true
    return route.fulfill({ json: { status: 'started', run_id: 91 } })
  })
  await page.route('**/api/scan/acknowledge', (route) => route.fulfill({ json: { status: 'acknowledged' } }))
  await page.route('**/api/scan/progress', (route) => {
    if (!run.started) return route.fulfill({ json: { status: 'idle', run_id: 0, source: null } })
    if (run.finished) return route.fulfill({ json: { ...base, status: 'done', ...run.final } })
    return route.fulfill({
      json: {
        ...base,
        status: 'running',
        step: 'metadata',
        attention_required: true,
        stalled_seconds: 95,
        current_item: 'Z:/share/slow.png',
        metadata_pending: 12,
        metadata_processed: 30,
        metadata_total: 42,
        diagnostics_available: true,
        new: 42,
      },
    })
  })
}

async function startImport(page: Page, tagAfter = false) {
  await page.getByTestId('import-button').click()
  const dialog = page.getByTestId('import-dialog')
  const pathInput = dialog.getByTestId('folder-path')
  await pathInput.fill(path.join(tmpRoot, DIR))
  await pathInput.press('Enter')
  if (tagAfter) {
    await dialog.getByText('Advanced').click()
    await dialog.getByTestId('import-tag-after').check()
    await expect(dialog).toContainText('This tags every untagged image in the library: 7 now, plus the new ones from this import.')
  }
  await dialog.getByRole('button', { name: 'Import this folder' }).click()
  await expect(dialog).toHaveCount(0)
}

test('a stalled import shows its diagnostics; once done it offers the next steps', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const run: ImportStub = {
    started: false,
    finished: false,
    final: { new: 3, updated: 0, errors: 0, processed: 5, total: 5, skipped_other_library: 2, skipped_other_library_paths: ['D:/other/a.png', 'D:/other/b.png'] },
  }
  await stubImport(page, run)
  let opened = 0
  const claimed: unknown[] = []
  await page.route('**/api/support/diagnostics**', (route) =>
    route.fulfill({
      json: { app_version: '4.0-test', log_file_path: 'C:/logs/app.log', log_file_path_redacted: '<LOG>/app.log', log_file_exists: true, log_level: 'INFO', recent_log_text: 'scan waiting on slow.png' },
    }),
  )
  await page.route('**/api/support/open-log', (route) => {
    opened += 1
    return route.fulfill({ json: { opened: true, path_redacted: '<LOG>/app.log' } })
  })
  await page.route('**/api/libraries/claim-paths', (route) => {
    claimed.push(route.request().postDataJSON())
    return route.fulfill({ json: { status: 'ok', moved: 2 } })
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, AFTER_REREAD)
  await startImport(page)

  await page.getByTestId('jobs-button').click()
  const card = page.getByTestId('scan-stall')
  await expect(card).toContainText('No visible progress for 95 s')
  await expect(card).toContainText('Z:/share/slow.png')
  await expect(page.getByTestId('jobs-button').locator('[data-trouble]')).toHaveCount(1)
  await card.getByRole('button', { name: 'Copy diagnostics' }).click()
  // The Windows clipboard hands lines back with CRLF.
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/Recent backend log:\r?\nscan waiting on slow\.png/)
  await card.getByRole('button', { name: 'Show the log file' }).click()
  await expect.poll(() => opened).toBe(1)

  run.finished = true
  await expect(card).toHaveCount(0)
  const next = page.getByTestId('import-next')
  await expect(page.getByText('2 already belong to another library; left there.')).toBeVisible()
  await next.getByRole('button', { name: 'Move 2 into this library' }).click()
  await expect.poll(() => claimed).toEqual([{ paths: ['D:/other/a.png', 'D:/other/b.png'] }])
  await expect(next.getByRole('button', { name: 'Move 2 into this library' })).toHaveCount(0)

  // Only the imported folder, whatever was searched before: 00–05 less the missing 03.
  await next.getByRole('button', { name: 'Show only this import' }).click()
  await expect(page.getByTestId('jobs-drawer')).toHaveCount(0)
  await expect(page.getByTestId('result-count')).toHaveText('5 images')
})

test('tagging after an import tags the untagged images, counted first; pending details point to a fix', async ({ page }) => {
  const run: ImportStub = { started: false, finished: true, final: { new: 3, updated: 0, errors: 0, processed: 3, total: 3 } }
  await stubImport(page, run)
  await page.route('**/api/library-health', (route) =>
    route.fulfill({
      json: { summary: { total_images: 50, readable_images: 50, tagged_percent: 80, actionable_count: 7 }, issue_counts: { untagged: 7, metadata_pending: 12 } },
    }),
  )
  await page.route('**/api/tagger/models', (route) => route.fulfill({ json: { models: [{ name: 'wd-swinv2-tagger-v3' }], default: 'wd-swinv2-tagger-v3' } }))
  await page.route('**/api/models/status', (route) =>
    route.fulfill({
      json: { models: [{ id: 'wd14', status: 'ready', available: true, variants: ['wd-swinv2-tagger-v3'], installed_variants: ['wd-swinv2-tagger-v3'] }] },
    }),
  )
  const tagged: Record<string, unknown>[] = []
  await page.route('**/api/tag/start', (route) => {
    tagged.push(route.request().postDataJSON())
    return route.fulfill({ json: { status: 'started' } })
  })
  await page.route('**/api/tag/progress', (route) =>
    route.fulfill({ json: tagged.length ? { status: 'done', run_id: 2, current: 10, total: 10, tagged: 10, errors: 0 } : { status: 'idle', run_id: 1 } }),
  )
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, TOKEN, AFTER_REREAD)

  // Details still pending with no import running: the fix is to import again.
  const status = page.getByTestId('library-status')
  await expect(status).toContainText('Generation details still being read for 12')
  await status.getByRole('button', { name: 'Import again…' }).click()
  await expect(page.getByTestId('import-dialog')).toBeVisible()
  await page.keyboard.press('Escape')

  await startImport(page, true)
  await expect.poll(() => tagged.length, { timeout: 15_000 }).toBe(1)
  expect(tagged[0]).not.toHaveProperty('image_ids')
  expect(tagged[0]).toMatchObject({ model_name: 'wd-swinv2-tagger-v3' })
  await expect(page.getByText('Imported: 3 new, then tagging the untagged images')).toBeVisible()
})

test('missing files: a found file already in the library, a preview to choose by, and clearing everything asks first', async ({ page }) => {
  // 04's file goes too: 03 and 04 are missing now; 04's file turned up as 05's (already indexed).
  fs.rmSync(path.join(tmpRoot, DIR, `${PREFIX}04.png`))
  const ids = JSON.parse(
    runBackendScript(`
import json, sqlite3
p = ${JSON.stringify(PREFIX)}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("UPDATE images SET is_readable = 0, metadata_status = 'error', read_error = 'File not found' WHERE filename = ?", (p + "04.png",))
    conn.commit()
    rows = conn.execute("SELECT filename, id, path FROM images WHERE filename IN (?, ?, ?)", (p + "03.png", p + "04.png", p + "05.png")).fetchall()
print(json.dumps({name: {"id": i, "path": pth} for name, i, pth in rows}))
`),
  ) as Record<string, { id: number; path: string }>
  const [r03, r04, r05] = ['03', '04', '05'].map((k) => ids[`${PREFIX}${k}.png`]!)
  await page.route('**/api/images/reconnect-missing/progress', (route) =>
    route.fulfill({
      json: {
        status: 'done',
        matched: 0,
        conflicts: 1,
        result: {
          conflict_samples: [
            { filename: `${PREFIX}04.png`, old_image_id: r04!.id, old_path: r04!.path, found_path: r05!.path, existing_image_id: r05!.id, existing_path: r05!.path },
          ],
        },
      },
    }),
  )
  await page.route('**/api/images/repair-candidates**', (route) =>
    route.fulfill({
      json: {
        total: 1,
        items: [
          { review_id: 5, filename: `${PREFIX}05.png`, found_path: r05!.path, found_exists: true, candidates: [{ image_id: r03!.id, path: r03!.path, file_size: 120, still_missing: true }] },
        ],
      },
    }),
  )
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, AFTER_REREAD - 1)

  const status = page.getByTestId('library-status')
  await expect(status).toContainText('2 files not found')
  await status.getByRole('button', { name: 'Deal with it…' }).click()
  const dialog = page.getByTestId('missing-dialog')

  // The found file is shown, so the choice is made by eye.
  const preview = dialog.getByTestId('review-preview')
  await expect(preview).toBeVisible()
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)

  // The old record of a file already in the library can go (asked first; no file touched).
  const already = dialog.getByTestId('missing-already')
  await expect(already).toContainText('Already in the library: 1')
  await already.getByRole('button', { name: 'Remove the old record…' }).click()
  await expect(already.getByTestId('missing-already-confirm')).toContainText('Remove 1 old record? No file is touched')
  await already.getByRole('button', { name: 'Remove 1' }).click()
  await expect(already).toHaveCount(0)
  await expect(dialog.getByTestId('missing-groups')).toContainText('1 image')
  expect(fs.existsSync(r05!.path)).toBe(true)

  // Clearing everything is asked in its own dialog, with Cancel focused.
  await dialog.getByTestId('missing-clear-all-open').click()
  const confirm = page.getByTestId('missing-clear-all')
  await expect(confirm).toContainText('Clear 1 record of missing files?')
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('missing-clear-all-open').click()
  await confirm.getByRole('button', { name: 'Clear 1' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(dialog).toContainText('No missing files.')
  await expect(page.getByText('Cleared 1 record')).toBeVisible()
})
