import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

/**
 * Owner feedback v3.5.0 (2026-07-04), gallery layout:
 *
 * FB-4 — collapsing the filter sidebar left a dead band where the sidebar
 * was: virtual-list items get their absolute position once at creation and
 * refresh()/_onResize() never repositioned them (plus an early-return when
 * the visible index range was unchanged). Locks: after collapse the grid
 * gains columns and the rendered items reach the widened right edge.
 *
 * FB-3 — there was no visible thumbnail-size control (#grid-size-slider was
 * referenced by app.js but absent from the markup, so the whole block —
 * including the [ / ] shortcuts — was dead). Locks: the toolbar control
 * exists, drives column count in grid AND waterfall modes, persists, and
 * the [ / ] shortcuts step the same value.
 *
 * Desktop-only project: viewport pinned at 1440x900.
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 900 } })

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

const SEARCH_TOKEN = 'v350_thumbsize_token'
// >= the virtual-scroll threshold (96) so grid mode exercises the REAL
// virtual-list path — the one that had the stale-position bug.
const IMAGE_COUNT = 120

function runBackendScript(script: string): string {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: repoRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

function resetThumbFixture(): number[] {
  const script = `
import json
import shutil
import sqlite3
from pathlib import Path
from PIL import Image

repo_root = Path(${JSON.stringify(repoRoot)})
root = repo_root / ".tmp" / "v350-thumb-size"
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)

token = ${JSON.stringify(SEARCH_TOKEN)}
count = ${IMAGE_COUNT}

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
ids = []
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM image_prompt_tokens WHERE image_id IN (SELECT id FROM images WHERE filename LIKE 'v350-thumb-%')"
    )
    cur.execute("DELETE FROM images WHERE filename LIKE 'v350-thumb-%'")
    for index in range(1, count + 1):
        filename = f"v350-thumb-{index}.png"
        image_path = (root / filename).resolve()
        shade = 40 + (index * 7) % 180
        Image.new("RGB", (32, 32), color=(shade, 90, 160)).save(image_path)
        cur.execute(
            """
            INSERT INTO images (
                path, filename, generator, prompt, negative_prompt, metadata_json,
                width, height, file_size, source_size, source_mtime_ns,
                is_readable, read_error, metadata_status, created_at
            ) VALUES (?, ?, 'unknown', ?, '', NULL, 32, 32, ?, ?, ?, 1, NULL, 'complete', CURRENT_TIMESTAMP)
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
    conn.commit()
print(json.dumps(ids))
`
  return JSON.parse(runBackendScript(script)) as number[]
}

function cleanupThumbFixture() {
  const script = `
import shutil
import sqlite3
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM image_prompt_tokens WHERE image_id IN (SELECT id FROM images WHERE filename LIKE 'v350-thumb-%')"
    )
    cur.execute("DELETE FROM images WHERE filename LIKE 'v350-thumb-%'")
    conn.commit()
shutil.rmtree(repo_root / ".tmp" / "v350-thumb-size", ignore_errors=True)
print("ok")
`
  runBackendScript(script)
}

async function openGalleryWithFixture(page: Page) {
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

  const search = page.locator('#gallery-search-input')
  await search.fill(SEARCH_TOKEN)
  await search.press('Enter')
  await expect
    .poll(async () => page.locator('#gallery-grid .gallery-item').count(), { timeout: 15000 })
    .toBeGreaterThan(10)
}

/** Distinct rounded x-positions of rendered items = column count. Works for
 *  both the virtual (absolute) and the CSS-grid fallback layout. */
async function countColumns(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#gallery-grid .gallery-item'))
    const lefts = new Set(items.map((el) => Math.round(el.getBoundingClientRect().left)))
    return lefts.size
  })
}

/** Gap in px between the rightmost rendered item edge and the grid's right
 *  edge. A stale layout after the sidebar collapses shows up as a gap of
 *  roughly one sidebar width. */
async function rightDeadBand(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const grid = document.getElementById('gallery-grid')
    if (!grid) return Number.NaN
    const items = Array.from(grid.querySelectorAll('.gallery-item'))
    if (items.length === 0) return Number.NaN
    const maxRight = Math.max(...items.map((el) => el.getBoundingClientRect().right))
    return grid.getBoundingClientRect().right - maxRight
  })
}

test.beforeAll(() => {
  const ids = resetThumbFixture()
  expect(ids.length).toBe(IMAGE_COUNT)
})

test.afterAll(() => {
  cleanupThumbFixture()
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.removeItem('sd-sorter:grid-size')
    localStorage.setItem('desktop-sidebar-collapsed', 'false')
    localStorage.setItem('gallery-view-mode', 'grid')
  })
})

test('FB-4: collapsing the sidebar reflows the virtual grid into the freed width', async ({ page }) => {
  await openGalleryWithFixture(page)

  // 120 fixture images >= threshold(96): the virtual path must be active,
  // otherwise this test would only exercise the self-reflowing CSS grid.
  await expect(page.locator('#gallery-grid')).toHaveClass(/virtual-scroll/)

  const columnsBefore = await countColumns(page)
  expect(columnsBefore).toBeGreaterThan(1)

  await page.locator('#btn-collapse-desktop-sidebar').click()

  // Sidebar margin transition (300ms) + resize debounce (100ms): poll until
  // the freed width is actually used — more columns, no dead band.
  await expect.poll(() => countColumns(page), { timeout: 5000 }).toBeGreaterThan(columnsBefore)
  const band = await rightDeadBand(page)
  expect(band).toBeLessThan(250)

  // Restore: columns settle back to the original count.
  await page.locator('#btn-restore-desktop-sidebar').click()
  await expect.poll(() => countColumns(page), { timeout: 5000 }).toBe(columnsBefore)
})

test('FB-3: toolbar thumbnail-size control drives grid density and persists', async ({ page }) => {
  await openGalleryWithFixture(page)

  const slider = page.locator('#grid-size-slider')
  await expect(slider).toBeVisible()
  await expect(slider).toHaveValue('200')

  const columnsAtDefault = await countColumns(page)

  // Smaller thumbnails -> more columns.
  await slider.fill('120')
  await expect.poll(() => countColumns(page), { timeout: 5000 }).toBeGreaterThan(columnsAtDefault)
  expect(await page.evaluate(() => localStorage.getItem('sd-sorter:grid-size'))).toBe('120')

  // Larger thumbnails -> fewer columns than the dense layout.
  await slider.fill('400')
  await expect.poll(() => countColumns(page), { timeout: 5000 }).toBeLessThan(columnsAtDefault)

  // +/- buttons step by 20 on the same value.
  await page.locator('#grid-size-decrease').click()
  await expect(slider).toHaveValue('380')
  await page.locator('#grid-size-increase').click()
  await expect(slider).toHaveValue('400')

  // [ / ] shortcuts step the SAME state (they were dead before the control
  // existed: the whole handler block was gated on #grid-size-slider). Blur
  // first: the shortcut ignores keystrokes while an input has focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('[')
  await expect(slider).toHaveValue('380')
  await page.keyboard.press(']')
  await expect(slider).toHaveValue('400')
})

test('FB-3: thumbnail size also drives the waterfall layout', async ({ page }) => {
  await openGalleryWithFixture(page)

  await page.locator('.view-btn[data-size="waterfall"]').click()
  await expect
    .poll(async () => page.locator('#gallery-grid .gallery-item').count(), { timeout: 15000 })
    .toBeGreaterThan(10)

  const columnsAtDefault = await countColumns(page)
  expect(columnsAtDefault).toBeGreaterThan(1)

  await page.locator('#grid-size-slider').fill('120')
  await expect.poll(() => countColumns(page), { timeout: 5000 }).toBeGreaterThan(columnsAtDefault)
})
