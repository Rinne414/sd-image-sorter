import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Tagger audit trio (v3.5.0, owner-approved 2026-07-07):
 *
 *   P2-19 training-purpose filter — the export modal's purpose dropdown
 *     drops style/artist rows (style mode) through the REAL export engine,
 *     and the preview endpoint stays WYSIWYG with it.
 *   P2-18 implication dedup — the checkbox collapses redundant parent tags
 *     (cat_ears present → animal_ears dropped).
 *   P1-17 trait pruning — the 🎯 checklist surfaces innate character traits
 *     shared across the selection and appends the picked ones to the
 *     existing export blacklist (reviewable, never silent).
 *
 * Engine semantics are locked by backend/tests/test_tag_training_filters.py;
 * this spec locks the UI wiring end-to-end against the live backend.
 */

test.describe.configure({ mode: 'serial' })

const repoRoot = path.resolve(__dirname, '..', '..', '..')

function commandExists(candidate: string): boolean {
  if (candidate.includes(path.sep) || candidate.includes('/')) {
    return fsSync.existsSync(candidate)
  }
  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    return execFileSync(lookupCommand, [candidate], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0
  } catch {
    return false
  }
}

const backendPythonCandidates = process.platform === 'win32' ? [
  path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
  path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
  'python',
] : [
  path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
  'python3',
  'python',
  path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
]

const backendPython = process.env.PW_BACKEND_PYTHON
  || backendPythonCandidates.find((candidate) => commandExists(candidate))
  || backendPythonCandidates[0]
const runtimeDatabasePath = process.env.SD_IMAGE_SORTER_DB_PATH
  || path.join(repoRoot, 'data', 'images.db')

const SEARCH_TOKEN = 'v350_trainfilter_token'
const IMAGE_COUNT = 4

function runBackendScript(script: string): string {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: repoRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

/**
 * 4 PNGs whose tag rows exercise every filter: silver_hair/red_eyes (trait
 * candidates on every image), cat_ears + animal_ears (bundled implication
 * pair), wlop stored with category='artist' (style-purpose target), 1girl
 * (untouched control).
 */
function resetTrainingFixture(): number[] {
  const script = `
import json
import shutil
import sqlite3
from pathlib import Path
from PIL import Image

repo_root = Path(${JSON.stringify(repoRoot)})
root = repo_root / ".tmp" / "v350-training-filters"
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)

token = ${JSON.stringify(SEARCH_TOKEN)}
filenames = [f"v350-trainfilter-{index}.png" for index in range(1, ${IMAGE_COUNT} + 1)]
colors = [(200, 90, 90), (90, 200, 90), (90, 90, 200), (200, 200, 90)]

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
ids = []
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    for filename, color in zip(filenames, colors):
        image_path = (root / filename).resolve()
        Image.new("RGB", (96, 96), color=color).save(image_path)

        cur.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename = ?)", (filename,))
        cur.execute("DELETE FROM image_prompt_tokens WHERE image_id IN (SELECT id FROM images WHERE filename = ?)", (filename,))
        cur.execute("DELETE FROM images WHERE filename = ?", (filename,))
        cur.execute(
            """
            INSERT INTO images (
                path, filename, generator, prompt, negative_prompt, metadata_json,
                width, height, file_size, source_size, source_mtime_ns,
                is_readable, read_error, metadata_status, created_at
            ) VALUES (?, ?, 'unknown', ?, '', NULL, 96, 96, ?, ?, ?, 1, NULL, 'complete', CURRENT_TIMESTAMP)
            """,
            (
                str(image_path), filename, token,
                image_path.stat().st_size, image_path.stat().st_size,
                image_path.stat().st_mtime_ns,
            ),
        )
        image_id = cur.lastrowid
        ids.append(image_id)
        cur.execute(
            "INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)",
            (image_id, token.lower().replace('_', ' ').strip()),
        )
        for tag, confidence, category in [
            ("silver_hair", 0.95, "general"),
            ("red_eyes", 0.9, "general"),
            ("cat_ears", 0.85, "general"),
            ("animal_ears", 0.8, "general"),
            ("wlop", 0.75, "artist"),
            ("1girl", 0.7, "general"),
        ]:
            cur.execute(
                "INSERT INTO tags (image_id, tag, confidence, category) VALUES (?, ?, ?, ?)",
                (image_id, tag, confidence, category),
            )
    conn.commit()
print(json.dumps(ids))
`
  return JSON.parse(runBackendScript(script)) as number[]
}

function cleanupTrainingFixture() {
  const script = `
import shutil
import sqlite3
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = Path(${JSON.stringify(runtimeDatabasePath)})
filenames = tuple(f"v350-trainfilter-{index}.png" for index in range(1, ${IMAGE_COUNT} + 1))
placeholders = ",".join("?" for _ in filenames)
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute(f"DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename IN ({placeholders}))", filenames)
    cur.execute(f"DELETE FROM image_prompt_tokens WHERE image_id IN (SELECT id FROM images WHERE filename IN ({placeholders}))", filenames)
    cur.execute(f"DELETE FROM images WHERE filename IN ({placeholders})", filenames)
    conn.commit()
shutil.rmtree(repo_root / ".tmp" / "v350-training-filters", ignore_errors=True)
print("ok")
`
  runBackendScript(script)
}

async function openMainPage(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect.poll(async () => {
    return await page.evaluate(() => {
      return Boolean(
        window.App
          && typeof window.App.loadImages === 'function'
          && window.App.AppState?.isLoading === false
      )
    })
  }).toBe(true)
}

async function selectFixtureAndOpenExportModal(page: Page, ids: number[]) {
  const search = page.locator('#gallery-search-input')
  await search.fill(SEARCH_TOKEN)
  await search.press('Enter')
  await expect(page.locator('#gallery-grid .gallery-item[data-id]')).toHaveCount(IMAGE_COUNT, { timeout: 15000 })

  await page.locator('#btn-toggle-select').click()
  for (const id of ids) {
    await page.locator(`#gallery-grid .gallery-item[data-id="${id}"]`).click()
  }
  await expect.poll(async () => page.evaluate(() => window.getSelectedGalleryCount())).toBe(IMAGE_COUNT)

  await page.evaluate(() => window.showBatchExportModal())
  await expect(page.locator('#batch-export-modal')).toBeVisible()
  await page.locator('#batch-export-content-mode').selectOption('tags')
  // The trio lives inside the collapsed Advanced panel.
  await page.locator('#batch-export-advanced-options').evaluate((details) => {
    (details as HTMLDetailsElement).open = true
  })
}

/** Render one fixture image through export-preview with the CURRENT UI state. */
async function renderPreviewLine(page: Page, imageId: number): Promise<string> {
  return await page.evaluate(async (id) => {
    const integration = (window as any).V321Integration
    const opts = integration._previewOptionsForContentMode('tags')
    const response = await fetch('/api/tags/export-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_ids: [id], ...opts }),
    })
    const data = await response.json()
    return data.results?.[0]?.rendered || ''
  }, imageId)
}

let fixtureIds: number[] = []

test.beforeAll(() => {
  fixtureIds = resetTrainingFixture()
  expect(fixtureIds.length).toBe(IMAGE_COUNT)
})

test.afterAll(() => {
  cleanupTrainingFixture()
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('P2-19 + P2-18: purpose filter and implication dedup flow through preview and export payload', async ({ page }) => {
  await openMainPage(page)
  await selectFixtureAndOpenExportModal(page, fixtureIds)

  // Defaults off: every tag renders (underscores normalized to spaces).
  const baseline = await renderPreviewLine(page, fixtureIds[0])
  expect(baseline).toContain('wlop')
  expect(baseline).toContain('animal ears')
  expect(baseline).toContain('cat ears')

  // Style purpose + implication dedup on. The native checkbox input is
  // hidden behind the styled .checkbox-custom span — click that instead.
  await page.locator('#batch-export-training-purpose').selectOption('style')
  await page.locator('label:has(#batch-export-dedupe-implications) .checkbox-custom').click()
  await expect(page.locator('#batch-export-dedupe-implications')).toBeChecked()

  const filtered = await renderPreviewLine(page, fixtureIds[0])
  expect(filtered).not.toContain('wlop')          // P2-19: artist row dropped
  expect(filtered).not.toContain('animal ears')   // P2-18: implied parent dropped
  expect(filtered).toContain('cat ears')          // the more specific child stays
  expect(filtered).toContain('silver hair')
  expect(filtered).toContain('1girl')

  // The export payload carries the same two fields the preview used.
  let capturedBody: Record<string, unknown> | null = null
  await page.route('**/api/tags/export-batch/start', async (route) => {
    capturedBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ json: { status: 'started' } })
  })
  await page.route('**/api/tags/export-batch/progress', async (route) => {
    await route.fulfill({
      json: {
        status: 'done',
        result: {
          status: 'ok', exported: IMAGE_COUNT, skipped: 0,
          error_count: 0, error_messages: [], total: IMAGE_COUNT,
        },
      },
    })
  })

  await page.locator('#btn-start-batch-export').click()
  await expect.poll(() => capturedBody !== null).toBe(true)
  const body = capturedBody as unknown as {
    training_purpose?: string,
    dedupe_implications?: boolean,
  }
  expect(body.training_purpose).toBe('style')
  expect(body.dedupe_implications).toBe(true)
  await expect(page.locator('#batch-export-modal')).toBeHidden()
})

test('P1-17: trait-pruner checklist appends picked traits to the export blacklist', async ({ page }) => {
  await openMainPage(page)
  await selectFixtureAndOpenExportModal(page, fixtureIds)

  const pruneButton = page.locator('#btn-export-trait-pruner')
  await expect(pruneButton).toBeVisible()
  await pruneButton.click()

  const panel = page.locator('#batch-export-modal .trait-pruner-panel')
  await expect(panel).toBeVisible({ timeout: 15000 })

  // All 4 images share the traits → ratio 1.0 → pre-checked. Clothing /
  // composition tags are never offered.
  const silverHairRow = panel.locator('input[data-trait-tag="silver_hair"]')
  await expect(silverHairRow).toBeChecked()
  await expect(panel.locator('input[data-trait-tag="red_eyes"]')).toBeChecked()
  await expect(panel.locator('input[data-trait-tag="cat_ears"]')).toBeChecked()
  await expect(panel.locator('input[data-trait-tag="1girl"]')).toHaveCount(0)
  await expect(panel.locator('input[data-trait-tag="wlop"]')).toHaveCount(0)

  // Uncheck one to prove the checklist is a real review step.
  await panel.locator('input[data-trait-tag="red_eyes"]').uncheck()
  await panel.getByRole('button', { name: /Add checked to blacklist/i }).click()

  const blacklist = page.locator('#batch-export-blacklist')
  const value = await blacklist.inputValue()
  expect(value).toContain('silver_hair')
  expect(value).toContain('cat_ears')
  expect(value).not.toContain('red_eyes')
  await expect(page.locator('#batch-export-modal .trait-pruner-panel')).toHaveCount(0)

  // Re-open: already-blacklisted traits are not duplicated on a second add.
  await pruneButton.click()
  await expect(page.locator('#batch-export-modal .trait-pruner-panel')).toBeVisible({ timeout: 15000 })
  await page.locator('#batch-export-modal .trait-pruner-panel')
    .getByRole('button', { name: /Add checked to blacklist/i }).click()
  const secondValue = await blacklist.inputValue()
  expect(secondValue.match(/silver_hair/g)?.length).toBe(1)
})

test('P1-17: Dataset Maker workbench exposes the same trait-pruner button', async ({ page }) => {
  await openMainPage(page)
  // Dataset Maker binds lazily on first view entry; only the wiring is
  // asserted here (queue seeding is covered by dataset specs). attach()
  // stamps aria-expanded on the button, which is the wiring marker.
  await page.evaluate(() => window.App.switchView('dataset'))
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const button = document.getElementById('btn-dataset-trait-pruner')
      return Boolean(button && button.getAttribute('aria-expanded') !== null)
    })
  }).toBe(true)
})
