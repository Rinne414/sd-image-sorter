/**
 * Aurora Phase 3 — Slice 1: nav rail + Gallery #25a.
 *
 * Covers the four new surfaces of this slice:
 *  1. Left nav rail (view switching, collapse persistence, brand → entry page)
 *  2. Gallery toolbar (key:value search parsing, quick chips)
 *  3. Fixed bottom action bar in selection mode (♥ pick-order badges,
 *     More▾ menu Escape isolation, tag-selected scoping note)
 *  4. Roadmap-C repair review (ambiguous reconnect → review modal → pick)
 */
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test } from '@playwright/test'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const runtimeDatabasePath = process.env.SD_IMAGE_SORTER_DB_PATH
  || path.join(repoRoot, 'data', 'images.db')
const fixtureRoot = path.join(repoRoot, '.tmp', 'manual-test', 'aurora-phase3')
const actionBarDir = path.join(fixtureRoot, 'action-bar')
const repairOldA = path.join(fixtureRoot, 'repair', 'old-a')
const repairOldB = path.join(fixtureRoot, 'repair', 'old-b')
const repairFoundDir = path.join(fixtureRoot, 'repair', 'found')
const repairFilename = 'aurora-repair-dup.png'

const RAIL_VIEWS = ['reader', 'sorting', 'censor', 'similar', 'dataset', 'promptlab', 'artist', 'gallery']

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

function runBackendScript(script: string) {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: repoRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

function deleteRowsByFilenames(filenames: string[]) {
  runBackendScript(`
import sqlite3
from pathlib import Path

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
names = ${JSON.stringify(filenames)}
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    marks = ",".join("?" for _ in names)
    cur.execute(f"DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename IN ({marks}))", names)
    cur.execute(f"DELETE FROM images WHERE filename IN ({marks})", names)
    cur.execute("DELETE FROM reconnect_reviews WHERE filename IN (%s)" % marks, names)
    conn.commit()
print("ok")
`)
}

function makePng(filePath: string, color: string) {
  runBackendScript(`
from pathlib import Path
from PIL import Image

target = Path(${JSON.stringify(filePath)})
target.parent.mkdir(parents=True, exist_ok=True)
Image.new("RGB", (96, 96), color=${JSON.stringify(color)}).save(target)
print("ok")
`)
}

async function scanFolder(request: any, folder: string) {
  const response = await request.post('/api/scan', {
    data: { folder_path: folder, recursive: true },
  })
  expect(response.ok()).toBeTruthy()
  await expect.poll(async () => {
    const progress = await (await request.get('/api/scan/progress')).json()
    return String(progress.status || '')
  }, { timeout: 60000 }).toBe('done')
}

async function openMainPage(page: any) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect.poll(async () => {
    return await page.evaluate(() => Boolean(
      (window as any).App
        && typeof (window as any).App.loadImages === 'function'
        && (window as any).App.AppState?.isLoading === false
    ))
  }).toBe(true)
}

test.describe('Aurora Phase 3 — nav rail', () => {
  test('rail is vertical, every view stays reachable, collapse persists', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await openMainPage(page)

    const railBox = await page.locator('.nav-bar').boundingBox()
    expect(railBox).not.toBeNull()
    expect(railBox!.width).toBeLessThan(280)
    expect(railBox!.height).toBeGreaterThan(600)

    for (const view of RAIL_VIEWS) {
      await page.locator(`#nav-tab-${view}`).click()
      await expect(page.locator(`#view-${view}`)).toHaveClass(/active/)
      await expect(page.locator(`#nav-tab-${view}`)).toHaveAttribute('aria-selected', 'true')
    }

    await page.locator('#btn-rail-collapse').click()
    await expect.poll(async () => {
      return await page.evaluate(() => document.documentElement.classList.contains('rail-collapsed'))
    }).toBe(true)
    // The rail animates width over 180ms — poll until it settles.
    await expect.poll(async () => {
      const box = await page.locator('.nav-bar').boundingBox()
      return box ? box.width : 0
    }).toBeLessThan(90)

    // Collapse survives a reload via the pre-paint localStorage class.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect.poll(async () => {
      return await page.evaluate(() => document.documentElement.classList.contains('rail-collapsed'))
    }).toBe(true)

    await page.locator('#btn-rail-collapse').click()
    await expect.poll(async () => {
      return await page.evaluate(() => document.documentElement.classList.contains('rail-collapsed'))
    }).toBe(false)
  })

  test('brand block returns to the mission entry page', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await openMainPage(page)

    await page.locator('#nav-brand').click()
    await expect(page.locator('#entry-page')).toBeVisible()

    // The entry page covers the rail; leave through its own gallery entry.
    await page.locator('#entry-fn-gallery').click()
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-gallery')).toHaveClass(/active/)
  })
})

test.describe('Aurora Phase 3 — gallery toolbar', () => {
  test('key:value search routes tokens into the filter store', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await openMainPage(page)

    await page.locator('#gallery-search-input').fill('tag:1girl checkpoint:"my model" seed:42 loose words')
    await page.locator('#gallery-search-input').press('Enter')

    await expect.poll(async () => {
      return await page.evaluate(() => {
        const filters = (window as any).App.AppState.filters
        return {
          hasTag: filters.tags.includes('1girl'),
          hasCheckpoint: filters.checkpoints.includes('my model'),
          seed: filters.seed,
          search: filters.search,
        }
      })
    }).toEqual({ hasTag: true, hasCheckpoint: true, seed: 42, search: 'loose words' })

    // Clearing the box clears only the box-owned (declarative) fields.
    await page.locator('#gallery-search-clear').click()
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const filters = (window as any).App.AppState.filters
        return { seed: filters.seed, search: filters.search, hasTag: filters.tags.includes('1girl') }
      })
    }).toEqual({ seed: null, search: '', hasTag: true })

    // Cleanup for later tests: drop the structured tokens too.
    await page.evaluate(async () => {
      const app = (window as any).App
      app.updateFilters((filters: any) => {
        filters.tags = []
        filters.checkpoints = []
      })
      app.updateFilterSummary()
      await app.loadImages()
    })
  })

  test('quick chips toggle their filter fields with pressed state', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await openMainPage(page)

    await page.locator('#chip-has-metadata').click()
    await expect(page.locator('#chip-has-metadata')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => {
      return await page.evaluate(() => (window as any).App.AppState.filters.hasMetadata)
    }).toBe(true)

    await page.locator('#chip-no-caption').click()
    await expect(page.locator('#chip-no-caption')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => {
      return await page.evaluate(() => (window as any).App.AppState.filters.noCaption)
    }).toBe(true)

    await page.locator('#chip-has-metadata').click()
    await page.locator('#chip-no-caption').click()
    await expect(page.locator('#chip-has-metadata')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('#chip-no-caption')).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const filters = (window as any).App.AppState.filters
        return filters.hasMetadata === null && filters.noCaption !== true
      })
    }).toBe(true)
  })
})

test.describe('Aurora Phase 3 — selection action bar', () => {
  const fixtureNames = ['aurora-bar-1.png', 'aurora-bar-2.png', 'aurora-bar-3.png']

  test.beforeAll(async () => {
    deleteRowsByFilenames(fixtureNames)
    await fs.rm(actionBarDir, { recursive: true, force: true })
    makePng(path.join(actionBarDir, fixtureNames[0]), 'red')
    makePng(path.join(actionBarDir, fixtureNames[1]), 'green')
    makePng(path.join(actionBarDir, fixtureNames[2]), 'blue')
  })

  test('selecting tiles shows the fixed bar, ♥ order badges, and an Esc-safe More menu', async ({ page, request }) => {
    test.setTimeout(120000)
    await page.setViewportSize({ width: 1600, height: 900 })
    await scanFolder(request, actionBarDir)
    await openMainPage(page)

    // Scope the gallery to the fixture rows so tile indexes are deterministic.
    await page.evaluate(async () => {
      const app = (window as any).App
      app.updateFilters((filters: any) => { filters.search = 'aurora-bar' })
      app.updateFilterSummary()
      await app.loadImages()
    })
    await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(3, { timeout: 15000 })

    await page.locator('#btn-toggle-select').click()
    const tiles = page.locator('#gallery-grid .gallery-item')
    await tiles.nth(0).click()
    await tiles.nth(1).click()

    const bar = page.locator('#gallery-action-bar')
    await expect(bar).toBeVisible()
    await expect(page.locator('#gallery-action-bar-stats')).not.toHaveText('')
    await expect(tiles.nth(0)).toHaveAttribute('data-sel-order', '1')
    await expect(tiles.nth(1)).toHaveAttribute('data-sel-order', '2')

    // More menu Escape must close ONLY the menu, never exit selection mode —
    // and never summon the ESC-to-entry page (its capture handler must defer
    // to the open menu regardless of listener registration order).
    await page.locator('#btn-gallery-action-more').click()
    await expect(page.locator('#gallery-action-more-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#gallery-action-more-menu')).toBeHidden()
    await expect(page.locator('#entry-page')).toBeHidden()
    expect(await page.evaluate(() => (window as any).App.AppState.selectionMode)).toBe(true)
    await expect(tiles.nth(0)).toHaveAttribute('data-sel-order', '1')

    // 打标 arms the tag modal with the explicit selection scope AND lands on the
    // 智能一趟 (Smart Tag) default tab (#25b), forwarding the selection scope.
    await page.locator('#btn-tag-selected').click()
    await expect(page.locator('#tag-modal')).toHaveClass(/visible/)
    await expect(page.locator('#tag-scope-note')).toBeVisible()
    await expect(page.locator('#tag-modal .tagger-tab[data-tagger-tab="smart"]')).toHaveClass(/active/)
    await expect(page.locator('.tagger-smart-launch')).toBeVisible()
    await expect(page.locator('#tagger-smart-scope')).toContainText('2')
    // The launch CTA opens the full Smart Tag workspace scoped to the selection.
    await page.locator('#btn-tagger-smart-go').click()
    await expect(page.locator('#smart-tag-modal')).toHaveClass(/visible/)
    await expect(page.locator('#smart-tag-image-count')).toHaveText('2')
    await page.locator('#btn-smart-tag-cancel-modal').click()
    await expect(page.locator('#smart-tag-modal')).not.toHaveClass(/visible/)
    // Re-open the tagger to exercise the scope-clear affordance.
    await page.locator('#btn-tag-selected').click()
    await expect(page.locator('#tag-modal')).toHaveClass(/visible/)
    await page.locator('#tag-modal .tagger-tab[data-tagger-tab="local"]').click()
    await expect(page.locator('#tag-scope-note')).toBeVisible()
    await page.locator('#btn-tag-scope-clear').click()
    await expect(page.locator('#tag-scope-note')).toBeHidden()
    await page.locator('#btn-close-tag-modal').click()
    await expect(page.locator('#tag-modal')).not.toHaveClass(/visible/)

    // Plain Escape with tiles selected: clears the selection but stays in
    // selection mode, and must NOT jump home — selection mode owns its ESC.
    await page.keyboard.press('Escape')
    await expect(tiles.nth(0)).not.toHaveAttribute('data-sel-order')
    await expect(page.locator('#entry-page')).toBeHidden()
    expect(await page.evaluate(() => (window as any).App.AppState.selectionMode)).toBe(true)

    // Leave selection mode so later specs start clean.
    await page.locator('#btn-toggle-select').click()
    await expect(bar).toBeHidden()
  })
})

test.describe('Aurora Phase 3 — repair review (Roadmap-C)', () => {
  test.beforeAll(async () => {
    deleteRowsByFilenames([repairFilename])
    await fs.rm(path.join(fixtureRoot, 'repair'), { recursive: true, force: true })
  })

  test('ambiguous reconnect surfaces a pending review; pick relinks the chosen row', async ({ page, request }) => {
    test.setTimeout(120000)
    // #btn-reconnect-missing is hidden below 1500px to free toolbar space.
    await page.setViewportSize({ width: 1600, height: 900 })

    // Two identical rows (same name+size) whose files then go missing, and one
    // discovered file that matches both — the locked ambiguous invariant.
    makePng(path.join(repairOldA, repairFilename), 'purple')
    await fs.mkdir(repairOldB, { recursive: true })
    await fs.copyFile(path.join(repairOldA, repairFilename), path.join(repairOldB, repairFilename))
    await scanFolder(request, path.join(fixtureRoot, 'repair'))

    await fs.mkdir(repairFoundDir, { recursive: true })
    await fs.copyFile(path.join(repairOldA, repairFilename), path.join(repairFoundDir, repairFilename))
    await fs.rm(path.join(repairOldA, repairFilename))
    await fs.rm(path.join(repairOldB, repairFilename))

    await openMainPage(page)
    await page.locator('#btn-reconnect-missing').click()
    await expect(page.locator('#reconnect-modal.visible')).toBeVisible()
    await page.locator('#reconnect-folder-path').fill(repairFoundDir)
    await page.locator('#btn-start-reconnect').click()

    let progress: any = null
    await expect.poll(async () => {
      progress = await (await request.get('/api/images/reconnect-missing/progress')).json()
      return String(progress.status || '')
    }, { timeout: 90000 }).toBe('done')
    expect(progress.ambiguous).toBe(1)
    expect(progress.review_pending_total).toBe(1)

    // Rows must be untouched until the user confirms (locked invariant).
    const pendingListing = await (await request.get('/api/images/repair-candidates')).json()
    expect(pendingListing.total).toBe(1)
    expect(pendingListing.items[0].candidates.length).toBe(2)
    for (const candidate of pendingListing.items[0].candidates) {
      expect(candidate.still_missing).toBe(true)
    }

    // Reopen the reconnect modal: the result panel carries the review CTA.
    if (!await page.locator('#reconnect-modal.visible').isVisible()) {
      await page.locator('#btn-reconnect-missing').click()
    }
    await expect(page.locator('#btn-open-repair-review')).toBeVisible({ timeout: 10000 })
    await page.locator('#btn-open-repair-review').click()
    await expect(page.locator('#repair-review-modal.visible')).toBeVisible()

    const row = page.locator('#repair-review-list .repair-review-item')
    await expect(row).toHaveCount(1, { timeout: 10000 })
    await expect(row.locator('input[type="radio"]')).toHaveCount(2)
    await expect(row.locator('input[type="radio"]').first()).toBeChecked()

    const chosenId = Number(await row.locator('input[type="radio"]').first().inputValue())
    await row.locator('.btn-primary').click()
    await expect(page.locator('#repair-review-list .repair-review-item')).toHaveCount(0, { timeout: 10000 })

    const afterListing = await (await request.get('/api/images/repair-candidates')).json()
    expect(afterListing.total).toBe(0)

    // The chosen row now points at the found file; the competitor is intact
    // with its old path. Checked in the DB directly — the gallery listing
    // hides unreadable (still-missing) rows by design, so the API would
    // only surface the relinked one.
    const dbState = runBackendScript(`
import json
import sqlite3
from pathlib import Path

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    rows = conn.execute(
        "SELECT id, path, is_readable FROM images WHERE filename = ? ORDER BY id",
        (${JSON.stringify(repairFilename)},),
    ).fetchall()
print(json.dumps([{"id": r[0], "path": r[1], "is_readable": r[2]} for r in rows]))
`)
    const rows = JSON.parse(dbState)
    expect(rows.length).toBe(2)
    const chosenRow = rows.find((row: any) => Number(row.id) === chosenId)
    const otherRow = rows.find((row: any) => Number(row.id) !== chosenId)
    expect(chosenRow).toBeTruthy()
    expect(String(chosenRow.path)).toBe(path.join(repairFoundDir, repairFilename))
    expect(chosenRow.is_readable).toBe(1)
    expect(otherRow).toBeTruthy()
    expect(String(otherRow.path)).not.toBe(path.join(repairFoundDir, repairFilename))
  })
})
