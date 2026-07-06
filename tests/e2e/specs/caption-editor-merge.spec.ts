import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

/**
 * Aurora #25c caption consolidation (v3.5.0):
 *
 * The v321 batch-export Caption Editor adopts the Dataset Maker two-box
 * shape — a per-image Booru/Both/NL type segment plus an editable
 * natural-language box — and forwards image_types + image_nl_overrides in
 * the export payload. Backend compose correctness is locked by
 * backend/tests/test_tag_export_nl_types.py; this spec locks the UI wiring:
 *   1. an NL-bearing image renders with 'both' active by default (unified
 *      auto-both with the Dataset Maker); images without NL stay 'booru',
 *   2. the Both NL box is seeded from the stored nl_caption and editing it
 *      updates the "Will export" composed line,
 *   3. the export-batch payload carries image_types + image_nl_overrides.
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

const fixtureRoot = path.join(repoRoot, '.tmp', 'v350-caption-merge')
const SEARCH_TOKEN = 'v350_captionmerge_token'
const IMAGE_COUNT = 4
const STORED_SENTENCE = 'a stored e2e sentence about soft light'
const EDITED_SENTENCE = 'an edited merge sentence from e2e'

function runBackendScript(script: string): string {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: repoRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

/** 4 PNGs + DB rows with tags; the first two also carry a stored NL caption. */
function resetCaptionFixture(): number[] {
  const script = `
import json
import shutil
import sqlite3
from pathlib import Path
from PIL import Image

repo_root = Path(${JSON.stringify(repoRoot)})
root = repo_root / ".tmp" / "v350-caption-merge"
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)

token = ${JSON.stringify(SEARCH_TOKEN)}
filenames = [f"v350-cap-{index}.png" for index in range(1, ${IMAGE_COUNT} + 1)]
colors = [(220, 80, 80), (80, 220, 80), (80, 80, 220), (220, 220, 80)]

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
ids = []
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    for index, (filename, color) in enumerate(zip(filenames, colors)):
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
        cur.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, '1girl', 0.9)", (image_id,))
        cur.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, 'long_hair', 0.8)", (image_id,))
        if index < 2:
            cur.execute(
                "UPDATE images SET nl_caption = ?, ai_caption = ? WHERE id = ?",
                (${JSON.stringify(STORED_SENTENCE)}, "fused " + ${JSON.stringify(STORED_SENTENCE)}, image_id),
            )
    conn.commit()
print(json.dumps(ids))
`
  return JSON.parse(runBackendScript(script)) as number[]
}

function cleanupCaptionFixture() {
  const script = `
import shutil
import sqlite3
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = Path(${JSON.stringify(runtimeDatabasePath)})
filenames = tuple(f"v350-cap-{index}.png" for index in range(1, ${IMAGE_COUNT} + 1))
placeholders = ",".join("?" for _ in filenames)
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute(f"DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename IN ({placeholders}))", filenames)
    cur.execute(f"DELETE FROM image_prompt_tokens WHERE image_id IN (SELECT id FROM images WHERE filename IN ({placeholders}))", filenames)
    cur.execute(f"DELETE FROM images WHERE filename IN ({placeholders})", filenames)
    conn.commit()
shutil.rmtree(repo_root / ".tmp" / "v350-caption-merge", ignore_errors=True)
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

let fixtureIds: number[] = []

test.beforeAll(() => {
  fixtureIds = resetCaptionFixture()
  expect(fixtureIds.length).toBe(IMAGE_COUNT)
})

test.afterAll(() => {
  cleanupCaptionFixture()
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('caption editor two-box merge: type segment, NL box, composed preview, export payload', async ({ page }) => {
  await openMainPage(page)

  // Narrow the gallery to the fixture via toolbar search, then select all 4.
  const search = page.locator('#gallery-search-input')
  await search.fill(SEARCH_TOKEN)
  await search.press('Enter')
  await expect(page.locator('#gallery-grid .gallery-item[data-id]')).toHaveCount(IMAGE_COUNT, { timeout: 15000 })

  await page.locator('#btn-toggle-select').click()
  for (const id of fixtureIds) {
    await page.locator(`#gallery-grid .gallery-item[data-id="${id}"]`).click()
  }
  await expect.poll(async () => page.evaluate(() => window.getSelectedGalleryCount())).toBe(IMAGE_COUNT)

  // Open the batch export modal in a compose-eligible content mode.
  await page.evaluate(() => window.showBatchExportModal())
  await expect(page.locator('#batch-export-modal')).toBeVisible()
  await page.locator('#batch-export-content-mode').selectOption('tags')

  // Open the Caption Editor and pin the first fixture image as active.
  await page.locator('#btn-open-caption-editor').click()
  await expect(page.locator('#caption-editor-modal')).toHaveClass(/visible/)
  const firstQueueItem = page.locator(`#caption-editor-list .export-preview-queue-item[data-image-id="${fixtureIds[0]}"]`)
  await expect(firstQueueItem).toBeVisible({ timeout: 15000 })
  await firstQueueItem.click()

  // 1. Default state (Aurora #25c unified auto-both): the first fixture image
  //    carries a stored NL sentence, so it defaults to 'both' — the NL box and
  //    composed "will export" line are visible without a user action, matching
  //    the Dataset Maker. Images without an NL sentence still default to 'booru'.
  const seg = page.locator('#caption-editor-list .export-preview-captype-seg')
  await expect(seg).toBeVisible()
  await expect(seg.locator('.export-preview-captype-btn[data-caption-type="both"]')).toHaveClass(/is-active/)
  await expect(page.locator('#caption-editor-list .export-preview-nl')).toBeVisible()
  await expect(page.locator('#caption-editor-list .export-preview-willexport')).toBeVisible()

  // 2. Both is the default here; re-affirm it, then check the NL box is seeded
  //    with the stored sentence and the composed "will export" line shows tags
  //    followed by the sentence.
  await seg.locator('.export-preview-captype-btn[data-caption-type="both"]').click()
  const nlBox = page.locator('#caption-editor-list .export-preview-nl-textarea')
  await expect(nlBox).toBeVisible()
  await expect(nlBox).toHaveValue(STORED_SENTENCE)

  await nlBox.fill(EDITED_SENTENCE)
  // The NL box debounces 200ms and fully re-renders on blur.
  await page.waitForTimeout(350)
  await nlBox.blur()
  const willExport = page.locator('#caption-editor-list .export-preview-willexport-text')
  await expect(willExport).toContainText('1girl')
  await expect(willExport).toContainText(`, ${EDITED_SENTENCE}`)

  // Queue item carries the B+N type chip.
  await expect(firstQueueItem.locator('.export-preview-queue-captype')).toHaveText('B+N')

  // 3. Export: intercept the background-start endpoint and assert the payload
  //    carries the per-image type + edited NL sentence alongside image_ids.
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

  await page.locator('#btn-close-caption-editor').click()
  await expect(page.locator('#caption-editor-modal')).not.toHaveClass(/visible/)
  await page.locator('#btn-start-batch-export').click()

  await expect.poll(() => capturedBody !== null).toBe(true)
  const body = capturedBody as unknown as {
    image_ids?: number[],
    image_types?: Record<string, string>,
    image_nl_overrides?: Record<string, string>,
  }
  expect(body.image_ids ?? []).toEqual(expect.arrayContaining(fixtureIds))
  expect(body.image_types?.[String(fixtureIds[0])]).toBe('both')
  expect(body.image_nl_overrides?.[String(fixtureIds[0])]).toBe(EDITED_SENTENCE)

  // The mocked terminal progress closes the modal via the success path.
  await expect(page.locator('#batch-export-modal')).toBeHidden()
})
