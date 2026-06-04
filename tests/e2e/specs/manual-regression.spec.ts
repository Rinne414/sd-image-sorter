import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test } from '@playwright/test'

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
const manualRoot = path.join(repoRoot, '.tmp', 'manual-test')

const autoSepInbox = path.join(manualRoot, 'autosep-inbox')
const autoSepOut = path.join(manualRoot, 'autosep-out')

const manualSortInbox = path.join(manualRoot, 'manual-sort-inbox')
const manualSortTop = path.join(manualRoot, 'manual-top')
const manualSortLeft = path.join(manualRoot, 'manual-left')
const manualSortRight = path.join(manualRoot, 'manual-right')
const manualSortBottom = path.join(manualRoot, 'manual-bottom')

const saveOutPng = path.join(manualRoot, 'save-out-png')
const saveOutWebp = path.join(manualRoot, 'save-out-webp')
const saveOutJpg = path.join(manualRoot, 'save-out-jpg')
const scanBrowserRoot = path.join(manualRoot, 'scan-browser-root')
const scanBrowserPicked = path.join(scanBrowserRoot, 'picked-folder')
const tagIoRoot = path.join(manualRoot, 'tag-io')
const tagLiveRoot = path.join(manualRoot, 'tag-live-inbox')
const repoDetectableFixture = path.join(repoRoot, 'backend', 'favorites', '131592481_p26.webp')

function runBackendScript(script: string) {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: repoRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

function runBackendJson<T>(script: string): T {
  return JSON.parse(runBackendScript(script)) as T
}

function ensureLibraryImageEntry(imagePath: string): { id: number, filename: string, path: string } | null {
  if (!require('node:fs').existsSync(imagePath)) {
    return null
  }

  return runBackendJson<{ id: number, filename: string, path: string }>(`
import json
from pathlib import Path
import sys
sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, 'backend'))})
import database as db

image_path = Path(${JSON.stringify(imagePath)})
image_id = db.add_image(path=str(image_path), filename=image_path.name, metadata_json='{}')
print(json.dumps({"id": image_id, "filename": image_path.name, "path": str(image_path)}))
`)
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

async function clearDir(dir: string) {
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
}

async function moveFilesBack(sourceDir: string, destinationDir: string) {
  await ensureDir(sourceDir)
  await ensureDir(destinationDir)

  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue

    const fromPath = path.join(sourceDir, entry.name)
    const toPath = path.join(destinationDir, entry.name)

    await fs.rm(toPath, { force: true })
    await fs.rename(fromPath, toPath)
  }
}

async function countFiles(dir: string, extension?: string) {
  await ensureDir(dir)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries.filter((entry) => {
    if (!entry.isFile()) return false
    if (!extension) return true
    return entry.name.toLowerCase().endsWith(extension.toLowerCase())
  }).length
}

function ensureMoveSortFixtureImages() {
  const script = `
from pathlib import Path
from PIL import Image

repo_root = Path(${JSON.stringify(repoRoot)})
manual_root = repo_root / ".tmp" / "manual-test"
fixtures = {
    manual_root / "autosep-inbox" / "manual-autosep-1.png": (255, 90, 90),
    manual_root / "autosep-inbox" / "manual-autosep-2.png": (90, 180, 255),
    manual_root / "manual-sort-inbox" / "manual-sort-1.png": (255, 180, 90),
    manual_root / "manual-sort-inbox" / "manual-sort-2.png": (180, 255, 90),
    manual_root / "manual-sort-inbox" / "manual-sort-3.png": (180, 90, 255),
}
for image_path, color in fixtures.items():
    image_path.parent.mkdir(parents=True, exist_ok=True)
    if not image_path.exists():
        Image.new("RGB", (96, 96), color=color).save(image_path)
print("ok")
`
  runBackendScript(script)
}

async function openView(page, view: string) {
  const desktopTab = page.locator(`.nav-tabs [data-view="${view}"]`).first()
  if (await desktopTab.count()) {
    const box = await desktopTab.boundingBox()
    if (box && box.width > 0 && box.height > 0) {
      await desktopTab.click({ force: true })
      return
    }
  }

  const mobileToggle = page.locator('#mobile-menu-toggle')
  if (await mobileToggle.isVisible().catch(() => false)) {
    await mobileToggle.click({ force: true })
    await expect(page.locator('#mobile-nav-overlay')).toHaveClass(/visible/)
    await page.locator(`#mobile-nav-overlay .mobile-nav-item[data-view="${view}"]`).evaluate((node: HTMLButtonElement) => node.click())
    return
  }

  throw new Error(`Could not find navigation entry for ${view}`)
}

async function openMainPage(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const isVisible = (element: Element | null) => {
        if (!(element instanceof HTMLElement)) return false
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }

      return isVisible(document.querySelector('.nav-tabs [data-view="reader"]'))
        || isVisible(document.getElementById('mobile-menu-toggle'))
    })
  }).toBe(true)
  await expect.poll(async () => {
    return await page.evaluate(() => {
      return Boolean(
        window.App
          && typeof window.App.loadImages === 'function'
          && window.Gallery
          && typeof window.Gallery.setImages === 'function'
          && window.App.AppState?.isLoading === false
      )
    })
  }).toBe(true)
}

async function openSortingSubView(page, subView: 'autosep' | 'manual') {
  await openView(page, 'sorting')
  await expect(page.locator('#view-sorting.active')).toBeVisible()
  await page.locator(`.sorting-sub-tab[data-sorting-sub="${subView}"]`).click({ force: true })

  if (subView === 'autosep') {
    await expect(page.locator('#view-autosep')).toBeVisible()
  } else {
    await expect(page.locator('#view-manual')).toBeVisible()
  }
}

function normalizeImageSrc(value: string | null) {
  return String(value || '').split('?')[0]
}

async function resetAutoSeparateFixture() {
  await ensureDir(autoSepInbox)
  await ensureDir(autoSepOut)
  await moveFilesBack(autoSepOut, autoSepInbox)
  await clearDir(autoSepOut)
  ensureMoveSortFixtureImages()
}

async function resetManualSortFixture() {
  await ensureDir(manualSortInbox)
  for (const dir of [manualSortTop, manualSortLeft, manualSortRight, manualSortBottom]) {
    await ensureDir(dir)
    await moveFilesBack(dir, manualSortInbox)
    await clearDir(dir)
  }
  ensureMoveSortFixtureImages()
}

async function resetSaveOutputs() {
  for (const dir of [saveOutPng, saveOutWebp, saveOutJpg]) {
    await clearDir(dir)
  }
}

// The e2e DB persists across runs (per-port file), so favorites left by a prior
// workbench run would make a baseline+N count assertion non-deterministic
// (re-favoriting the same image is idempotent). Clear them for a clean baseline.
async function clearFavorites(request) {
  const payload = await (await request.get('/api/collections/favorites/ids')).json()
  for (const id of (payload.image_ids || [])) {
    await request.post('/api/collections/favorites', { data: { image_id: id, favorited: false } })
  }
}

function resetScanBrowserFixture() {
  const script = `
from pathlib import Path
from PIL import Image
import sqlite3

repo_root = Path(${JSON.stringify(repoRoot)})
root = repo_root / ".tmp" / "manual-test" / "scan-browser-root"
picked = root / "picked-folder"
picked.mkdir(parents=True, exist_ok=True)

files = {
    "manual-scan-browser-1.png": (picked / "manual-scan-browser-1.png", (255, 64, 64)),
    "manual-scan-browser-2.png": (picked / "manual-scan-browser-2.png", (64, 160, 255)),
}

for filename, (target, color) in files.items():
    Image.new("RGB", (96, 96), color=color).save(target)

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename IN (?, ?))", tuple(files.keys()))
    cur.execute("DELETE FROM images WHERE filename IN (?, ?)", tuple(files.keys()))
    conn.commit()

print('ok')
`

  runBackendScript(script)
}

function prepareTagIoFixture(): { imageId: number, filename: string, expectedTag: string } {
  const script = `
import json
import sqlite3
from pathlib import Path
from PIL import Image

repo_root = Path(${JSON.stringify(repoRoot)})
fixture_dir = repo_root / ".tmp" / "manual-test" / "tag-io"
fixture_dir.mkdir(parents=True, exist_ok=True)
image_path = fixture_dir / "manual-tag-io-source.png"
Image.new("RGB", (112, 112), color=(200, 120, 255)).save(image_path)

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
expected_tag = "manual_export_roundtrip_tag_20260409"

with sqlite3.connect(db_path) as conn:
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename = ?)", ("manual-tag-io-source.png",))
    cur.execute("DELETE FROM images WHERE filename = ?", ("manual-tag-io-source.png",))
    cur.execute(
        '''
        INSERT INTO images (
            path, filename, generator, prompt, negative_prompt, metadata_json,
            width, height, file_size, tagged_at, created_at
        ) VALUES (?, ?, 'unknown', ?, '', '{}', 112, 112, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ''',
        (str(image_path.resolve()), "manual-tag-io-source.png", "manual_tag_io_fixture_20260409", image_path.stat().st_size),
    )
    image_id = cur.lastrowid
    cur.execute(
        "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
        (image_id, expected_tag, 0.99),
    )
    cur.execute(
        "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
        (image_id, '1girl', 0.95),
    )
    conn.commit()

print(json.dumps({"imageId": image_id, "filename": "manual-tag-io-source.png", "expectedTag": expected_tag}))
`

  return runBackendJson(script)
}

function clearTagsForImage(imageId: number) {
  const script = `
import sqlite3
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute("DELETE FROM tags WHERE image_id = ?", (${imageId},))
    cur.execute("UPDATE images SET tagged_at = NULL WHERE id = ?", (${imageId},))
    conn.commit()
print("ok")
`
  runBackendScript(script)
}

function prepareTagLiveFixture() {
  const script = `
from pathlib import Path
from PIL import Image
import sqlite3

repo_root = Path(${JSON.stringify(repoRoot)})
fixture_dir = repo_root / ".tmp" / "manual-test" / "tag-live-inbox"
fixture_dir.mkdir(parents=True, exist_ok=True)

fixture_names = ["manual-tag-live-1.png", "manual-tag-live-2.png"]
colors = [(255, 180, 120), (120, 220, 255)]
for filename, color in zip(fixture_names, colors):
    Image.new("RGB", (128, 128), color=color).save(fixture_dir / filename)

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute("UPDATE images SET tagged_at = COALESCE(tagged_at, CURRENT_TIMESTAMP)")
    cur.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename IN (?, ?))", tuple(fixture_names))
    cur.execute("DELETE FROM images WHERE filename IN (?, ?)", tuple(fixture_names))
    conn.commit()

print("ok")
`
  runBackendScript(script)
}

function cleanupExtendedFixtureRows() {
  const script = `
import sqlite3
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = Path(${JSON.stringify(runtimeDatabasePath)})
fixture_names = (
    "manual-scan-browser-1.png",
    "manual-scan-browser-2.png",
    "manual-tag-io-source.png",
    "manual-tag-live-1.png",
    "manual-tag-live-2.png",
)

with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename IN (?, ?, ?, ?, ?))", fixture_names)
    cur.execute("DELETE FROM images WHERE filename IN (?, ?, ?, ?, ?)", fixture_names)
    conn.commit()

print("ok")
`
  runBackendScript(script)
}

function restoreManualFixtureDbPaths() {
  const script = `
import sqlite3
from PIL import Image
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = Path(${JSON.stringify(runtimeDatabasePath)})
manual_root = repo_root / ".tmp" / "manual-test"

fixture_rows = {
    "manual-autosep-1.png": {
        "path": manual_root / "autosep-inbox" / "manual-autosep-1.png",
        "prompt": "manual_test_autosep_token_20260405",
    },
    "manual-autosep-2.png": {
        "path": manual_root / "autosep-inbox" / "manual-autosep-2.png",
        "prompt": "manual_test_autosep_token_20260405",
    },
    "manual-sort-1.png": {
        "path": manual_root / "manual-sort-inbox" / "manual-sort-1.png",
        "prompt": "manual_test_sort_token_20260405",
    },
    "manual-sort-2.png": {
        "path": manual_root / "manual-sort-inbox" / "manual-sort-2.png",
        "prompt": "manual_test_sort_token_20260405",
    },
    "manual-sort-3.png": {
        "path": manual_root / "manual-sort-inbox" / "manual-sort-3.png",
        "prompt": "manual_test_sort_token_20260405",
    },
}

with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    for filename, config in fixture_rows.items():
        target_path = config["path"].resolve()
        prompt = config["prompt"]
        file_size = target_path.stat().st_size if target_path.exists() else 0
        source_mtime_ns = target_path.stat().st_mtime_ns if target_path.exists() else None
        width = None
        height = None

        if target_path.exists():
            with Image.open(target_path) as image:
                width, height = image.size

        cur.execute(
            """
            UPDATE images
            SET path = ?,
                prompt = ?,
                file_size = ?,
                width = ?,
                height = ?,
                source_size = ?,
                source_mtime_ns = ?,
                is_readable = 1,
                read_error = NULL,
                metadata_status = 'complete'
            WHERE filename = ?
            """,
            (str(target_path), prompt, file_size, width, height, file_size, source_mtime_ns, filename),
        )
        if cur.rowcount == 0:
            cur.execute(
                """
                INSERT INTO images (
                    path,
                    filename,
                    generator,
                    prompt,
                    negative_prompt,
                    metadata_json,
                    width,
                    height,
                    file_size,
                    source_size,
                    source_mtime_ns,
                    is_readable,
                    read_error,
                    metadata_status,
                    created_at
                ) VALUES (?, ?, 'unknown', ?, '', NULL, ?, ?, ?, ?, ?, 1, NULL, 'complete', CURRENT_TIMESTAMP)
                """,
                (str(target_path), filename, prompt, width, height, file_size, file_size, source_mtime_ns),
            )

        cur.execute("SELECT id FROM images WHERE filename = ?", (filename,))
        row = cur.fetchone()
        if row:
            image_id = row[0]
            cur.execute("DELETE FROM image_prompt_tokens WHERE image_id = ?", (image_id,))
            cur.execute(
                "INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)",
                (image_id, prompt.lower().replace('_', ' ').strip()),
            )
    conn.commit()
`

  execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: repoRoot,
    stdio: 'pipe',
  })
}

async function setGallerySearch(page, search: string) {
  await page.evaluate(async (value) => {
    const waitFor = async (predicate: () => boolean, timeout = 10000) => {
      const start = Date.now()
      while (!predicate()) {
        if (Date.now() - start > timeout) {
          throw new Error('Timed out waiting for gallery search helpers to initialize')
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    await waitFor(() => Boolean(window.App && typeof window.App.loadImages === 'function'))
    if (typeof window.App.updateFilters === 'function') {
      window.App.updateFilters((filters: any) => {
        filters.search = value
      })
    } else {
      window.App.AppState.filters.search = value
    }
    window.App.updateFilterSummary()
    await window.App.loadImages()
    await waitFor(() => window.App.AppState?.isLoading === false)
    await waitFor(() => Boolean(window.Gallery && typeof window.Gallery.setImages === 'function'))
    window.Gallery.setImages(window.App.AppState.images || [])
  }, search)
}

async function disableScanAutoTag(page) {
  await page.locator('#scan-auto-tag').evaluate((node) => {
    const input = node as HTMLInputElement
    input.checked = false
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function getFirstImageBySearch(request, search: string) {
  const response = await request.get(`/api/images?limit=10&search=${encodeURIComponent(search)}`)
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()
  expect(Array.isArray(payload.images)).toBeTruthy()
  expect(payload.images.length).toBeGreaterThan(0)
  return payload.images[0]
}

async function getImagesByFilenames(request, filenames: string[]) {
  const response = await request.get('/api/images?limit=1000&sort_by=newest')
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()
  const wanted = new Set(filenames)
  return (payload.images || []).filter((image: any) => wanted.has(String(image.filename)))
}

function formatArtistNameForUi(name: string) {
  const safeName = String(name ?? '').trim()
  if (!safeName || safeName === 'undefined') return 'Undefined'

  return safeName
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

async function findDetectableImage(request) {
  const seededFixture = ensureLibraryImageEntry(repoDetectableFixture)
  if (seededFixture) {
    const detect = await request.post('/api/censor/detect', {
      timeout: 120000,
      data: {
        image_id: seededFixture.id,
        model_type: 'both',
        confidence: 0.15,
        style: 'mosaic',
        block_size: 16,
        target_classes: ['breasts', 'pussy', 'dick', 'anus', 'cum'],
      },
    })
    if (detect.ok()) {
      const detectPayload = await detect.json()
      if ((detectPayload.detections || []).length > 0) {
        return seededFixture
      }
    }
  }

  const response = await request.get('/api/images?limit=20')
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()

  for (const image of payload.images || []) {
      const detect = await request.post('/api/censor/detect', {
        timeout: 120000,
        data: {
          image_id: image.id,
          model_type: 'both',
        confidence: 0.15,
        style: 'mosaic',
        block_size: 16,
        target_classes: ['breasts', 'pussy', 'dick', 'anus', 'cum'],
      },
    })
    if (!detect.ok()) {
      continue
    }
    const detectPayload = await detect.json()
    if ((detectPayload.detections || []).length > 0) {
      return image
    }
  }

  return null
}

async function findSam3PromptMatch(request) {
  const seededFixture = ensureLibraryImageEntry(repoDetectableFixture)
  if (seededFixture) {
    for (const prompt of ['person', 'face', 'hand', 'breasts']) {
      const segment = await request.post('/api/censor/segment-text', {
        timeout: 90000,
        data: {
          image_id: seededFixture.id,
          text_prompt: prompt,
        },
      })
      if (!segment.ok()) {
        continue
      }
      const segmentPayload = await segment.json()
      if (segmentPayload.mask) {
        return { image: seededFixture, prompt }
      }
    }
  }

  const response = await request.get('/api/images?limit=8')
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()
  const prompts = ['person', 'face', 'hand', 'breasts']

  for (const image of payload.images || []) {
    for (const prompt of prompts) {
      const segment = await request.post('/api/censor/segment-text', {
        timeout: 90000,
        data: {
          image_id: image.id,
          text_prompt: prompt,
        },
      })
      if (!segment.ok()) {
        continue
      }
      const segmentPayload = await segment.json()
      if (segmentPayload.mask) {
        return { image, prompt }
      }
    }
  }

  throw new Error('Could not find a SAM3 text-prompt match in the current library')
}

async function findArtistIdentifiableImage(request) {
  const response = await request.get('/api/images?limit=20')
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()

  for (const image of payload.images || []) {
    const identify = await request.post('/api/artists/identify', {
      timeout: 120000,
      data: {
        image_id: image.id,
        threshold: 0.0,
        top_k: 5,
      },
    })

    if (!identify.ok()) {
      continue
    }

    const identifyPayload = await identify.json()
    if (identifyPayload.artist && identifyPayload.artist !== 'undefined') {
      return {
        image,
        artist: String(identifyPayload.artist),
      }
    }
  }

  return null
}

test.beforeEach(async ({ page }) => {
  await resetAutoSeparateFixture()
  await resetManualSortFixture()
  cleanupExtendedFixtureRows()
  restoreManualFixtureDbPaths()
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('artist-guide-seen', 'true')
  })
})

test.afterAll(async () => {
  cleanupExtendedFixtureRows()
})

test('gallery selection actions should stay in the left sidebar instead of floating over the grid', async ({ page }) => {
  await openMainPage(page)

  await page.locator('#btn-toggle-select').click()
  const selectionPanel = page.locator('.filter-sidebar #selection-actions')
  const sidebar = page.locator('.filter-sidebar')

  await expect(selectionPanel).toBeVisible()
  await expect(selectionPanel).toContainText('Select images')

  const panelBox = await selectionPanel.boundingBox()
  const sidebarBox = await sidebar.boundingBox()
  expect(panelBox).not.toBeNull()
  expect(sidebarBox).not.toBeNull()
  expect(panelBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x - 1)
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width + 1)
})

test('filtered gallery selection should clear when gallery filters change', async ({ page }) => {
  await openMainPage(page)

  const state = await page.evaluate(() => {
    const app = (window as any).App
    const filterKey = app.getSelectionFilterCacheKey(app.AppState.filters)

    app.setSelectionMode(true, { clearSelectionWhenDisabled: false })
    app.setSelectionState({
      selectionMode: true,
      selectedIds: new Set([987654321]),
      scope: 'filtered',
      filterKey,
    })
    app.updateFilters((filters: any) => {
      filters.search = `selection_scope_changed_${Date.now()}`
    })

    return {
      selectedCount: app.AppState.selectedIds.size,
      selectionScope: app.AppState.selectionScope,
      selectionFilterKey: app.AppState.selectionFilterKey,
    }
  })

  expect(state).toEqual({
    selectedCount: 0,
    selectionScope: 'visible',
    selectionFilterKey: null,
  })
})

test('filtered gallery selection should drop offscreen IDs when switching to visible selection', async ({ page }) => {
  await openMainPage(page)

  const state = await page.evaluate(() => {
    const app = (window as any).App
    const gallery = (window as any).Gallery
    const grid = document.querySelector('#gallery-grid')
    if (!grid) throw new Error('gallery grid missing')

    const visibleItem = document.createElement('div')
    visibleItem.className = 'gallery-item'
    visibleItem.dataset.id = '123456'
    grid.appendChild(visibleItem)

    app.setSelectionMode(true, { clearSelectionWhenDisabled: false })
    app.setSelectionState({
      selectionMode: true,
      selectedIds: new Set([987654321]),
      scope: 'filtered',
      filterKey: app.getSelectionFilterCacheKey(app.AppState.filters),
    })

    gallery.toggleSelection(123456)

    return {
      selectedIds: Array.from(app.AppState.selectedIds).sort((a: any, b: any) => Number(a) - Number(b)),
      selectionScope: app.AppState.selectionScope,
      selectionFilterKey: app.AppState.selectionFilterKey,
    }
  })

  expect(state).toEqual({
    selectedIds: [123456],
    selectionScope: 'visible',
    selectionFilterKey: null,
  })
})

test('gallery filter modal should commit through FilterStore instead of mutating AppState directly', async ({ page }) => {
  await openMainPage(page)

  await page.evaluate(() => {
    const app = (window as any).App
    app.setFilters(app.createDefaultFilterState())
    ;(window as any).__filterStoreEvents = 0
    app.FilterStore.subscribe(() => {
      ;(window as any).__filterStoreEvents += 1
    })
  })

  await page.evaluate(async () => {
    await (window as any).App.openFilterModal()
  })
  await expect(page.locator('#filter-modal.visible')).toBeVisible()

  await page.locator('#modal-free-text-search').fill('filter_store_commit_probe')
  await page.locator('#btn-apply-modal-filters').click()
  await expect(page.locator('#filter-modal.visible')).toHaveCount(0)

  const committed = await page.evaluate(() => {
    const app = (window as any).App
    return {
      search: app.AppState.filters.search,
      storeEvents: (window as any).__filterStoreEvents,
    }
  })

  expect(committed.search).toBe('filter_store_commit_probe')
  expect(committed.storeEvents).toBeGreaterThan(0)

  await page.evaluate(async () => {
    const app = (window as any).App
    app.setFilters(app.createDefaultFilterState())
    app.updateFilterSummary()
    await app.loadImages()
  })
})

test('censor workspace sidebars should stay readable without covering the canvas', async ({ page }) => {
  await openMainPage(page)
  await openView(page, 'censor')
  await expect(page.locator('#view-censor.active')).toBeVisible()

  const layout = await page.evaluate(() => {
    const left = document.querySelector('#view-censor .censor-sidebar-v2.left')?.getBoundingClientRect()
    const main = document.querySelector('#view-censor .censor-main-v2')?.getBoundingClientRect()
    const right = document.querySelector('#view-censor .censor-sidebar-v2.right')?.getBoundingClientRect()
    const queueManagerButton = document.getElementById('btn-open-queue-manager')?.getBoundingClientRect()
    const detectionSection = document.getElementById('censor-model-type')?.closest('.censor-side-card')?.getBoundingClientRect()
    return {
      left,
      main,
      right,
      queueManagerButton,
      detectionSection,
    }
  })

  expect(layout.left).not.toBeNull()
  expect(layout.main).not.toBeNull()
  expect(layout.right).not.toBeNull()
  expect(layout.queueManagerButton).not.toBeNull()
  expect(layout.detectionSection).not.toBeNull()

  expect(layout.left!.right).toBeLessThanOrEqual(layout.main!.left + 1)
  expect(layout.main!.right).toBeLessThanOrEqual(layout.right!.left + 1)
  expect(layout.main!.width).toBeGreaterThan(320)
  expect(layout.queueManagerButton!.width).toBeGreaterThan(120)
  expect(layout.detectionSection!.height).toBeGreaterThan(120)
})

test('censor queue warning should fire once even after re-entering the tab', async ({ page }) => {
  await openMainPage(page)

  await page.evaluate(() => {
    const original = window.App.showToast
    let count = 0
    ;(window as Window & { __toastInvocationCount?: number }).__toastInvocationCount = 0
    window.App.showToast = (...args) => {
      count += 1
      ;(window as Window & { __toastInvocationCount?: number }).__toastInvocationCount = count
      return original(...args)
    }
  })

  await openView(page, 'censor')
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await openView(page, 'gallery')
  await expect(page.locator('#view-gallery.active')).toBeVisible()
  await openView(page, 'censor')
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await openView(page, 'similar')
  await expect(page.locator('#view-similar.active')).toBeVisible()
  await openView(page, 'censor')
  await expect(page.locator('#view-censor.active')).toBeVisible()

  await page.evaluate(() => {
    const button = document.getElementById('btn-queue-move-top') as HTMLButtonElement | null
    button?.click()
  })
  await expect(page.locator('#toast-container')).toContainText('Select at least one queue item first')

  await expect.poll(async () => {
    return await page.evaluate(() => (window as Window & { __toastInvocationCount?: number }).__toastInvocationCount || 0)
  }).toBe(1)
})

test('censor settings should open, explain model roles, and allow typing the pro prompt', async ({ page }) => {
  await openMainPage(page)

  await openView(page, 'censor')
  await expect(page.locator('#view-censor.active')).toBeVisible()

  await page.locator('#btn-open-detect-modal').click()
  await expect(page.locator('#detect-modal.visible')).toBeVisible()

  await expect.poll(async () => {
    return (await page.locator('#censor-capability-panel').textContent()) || ''
  }, { timeout: 15000 }).toMatch(/Built-in NSFW body-part classes/)
  await expect.poll(async () => {
    return (await page.locator('#censor-capability-panel').textContent()) || ''
  }, { timeout: 15000 }).toMatch(/Prompt-guided segmentation/)

  const promptInput = page.locator('#censor-text-prompt')
  await promptInput.evaluate((node) => {
    const details = node.closest('details') as HTMLDetailsElement | null
    if (details) details.open = true
  })
  await expect(page.locator('#censor-pro-segmentation-group')).toHaveAttribute('open', '')
  await expect(promptInput).toBeEnabled()
  await promptInput.click()
  await promptInput.pressSequentially('face')
  await expect(promptInput).toHaveValue('face')
  const segmentButton = page.locator('#btn-segment-text-current')
  const promptHelp = page.locator('#censor-text-prompt-help')
  await expect(segmentButton).toBeVisible()
  await expect(promptHelp).toContainText(/SAM3|精细工具|暂时跑不了 SAM3/i)

  await page.selectOption('#censor-model-type', 'nudenet')
  await expect(page.locator('#censor-simple-guide')).toContainText('NudeNet')
  await expect(page.locator('#censor-simple-guide')).toContainText('no text prompt')

  await page.locator('#censor-model-file').evaluate((node) => {
    const details = node.closest('details') as HTMLDetailsElement | null
    if (details) details.open = true
  })
  const defaultOptionTexts = await page.locator('#censor-model-file option').allTextContents()
  const hasAdvancedModelOptionBeforeToggle = defaultOptionTexts.some((text) => text.includes('Advanced test only'))
  expect(hasAdvancedModelOptionBeforeToggle).toBeFalsy()
  await page.locator('#censor-show-advanced-models').evaluate((node) => {
    const input = node as HTMLInputElement
    input.checked = true
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const advancedHelp = page.locator('#censor-advanced-models-help')
  const advancedOptionTexts = await page.locator('#censor-model-file option').allTextContents()
  const hasAdvancedModelOption = advancedOptionTexts.some((text) => text.includes('Advanced test only'))

  if (!hasAdvancedModelOption) {
    await expect(advancedHelp).toContainText(/No extra general YOLO compatibility models were found locally|本地没有额外的通用 YOLO 兼容模型/i)
    return
  }

  await expect(advancedHelp).toContainText(/advanced fixed-class YOLO|segmentation experiments/i)

  const generalModelPath = await page.locator('#censor-model-file option').evaluateAll((options) => {
    const match = options.find((option) => option.textContent?.includes('Advanced test only'))
    return match?.getAttribute('value') || null
  })

  expect(generalModelPath).toBeTruthy()
  await page.selectOption('#censor-model-type', 'legacy')
  await page.selectOption('#censor-model-file', String(generalModelPath))
  await expect(page.locator('#censor-simple-guide')).toContainText('general fixed-class segmentation model')
  await expect(page.locator('#censor-target-region-group')).toBeVisible()
  await expect(page.locator('#censor-target-region-help')).toContainText(/switch back to the recommended privacy detector|Wenaka \/ NudeNet families|自动切回推荐的隐私检测路线/i)
  await expect(page.locator('.target-region-check').first()).toBeEnabled()
})

test('sam3 text segmentation should work through the real UI when the runtime is ready', async ({ page, request }) => {
  test.setTimeout(120000)

  const modelsResponse = await request.get('/api/censor/models')
  expect(modelsResponse.ok()).toBeTruthy()
  const modelsPayload = await modelsResponse.json()
  const sam3Model = (modelsPayload.models || []).find((model: any) => model?.id === 'sam3')
  test.skip(!sam3Model?.available, sam3Model?.message || 'SAM3 runtime is not ready in this workspace')

  const { image, prompt } = await findSam3PromptMatch(request)

  await openMainPage(page)

  await setGallerySearch(page, image.filename)
  await expect(page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`)).toBeVisible()

  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`).click()
  await page.locator('#btn-send-to-censor').click()

  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(1, { timeout: 15000 })

  await page.locator('#btn-open-detect-modal').click()
  await expect(page.locator('#detect-modal.visible')).toBeVisible()

  const promptInput = page.locator('#censor-text-prompt')
  await promptInput.evaluate((node) => {
    const details = node.closest('details') as HTMLDetailsElement | null
    if (details) details.open = true
  })
  await expect(page.locator('#censor-pro-segmentation-group')).toHaveAttribute('open', '')
  await promptInput.fill('')
  await promptInput.pressSequentially(prompt)
  await page.locator('#btn-segment-text-current').click()

  await expect.poll(async () => {
    return await page.locator('#censor-queue-list .queue-thumb-v2.processed').count()
  }, { timeout: 60000 }).toBe(1)
  await expect(page.locator('#toast-container')).toContainText('Applied SAM3 mask', { timeout: 10000 })
})

test('artist identify selected should work on a real image', async ({ page, request }) => {
  const probeImagesResponse = await request.get('/api/images?limit=1')
  expect(probeImagesResponse.ok()).toBeTruthy()
  const probeImagesPayload = await probeImagesResponse.json()
  const probeImage = probeImagesPayload.images?.[0]

  if (probeImage?.id) {
    const probeIdentify = await request.post('/api/artists/identify', {
      timeout: 120000,
      data: {
        image_id: probeImage.id,
        threshold: 0.0,
        top_k: 1,
      },
    })
    if (probeIdentify.status() === 503) {
      const probePayload = await probeIdentify.json().catch(() => ({}))
      test.skip(true, probePayload?.detail || 'Artist identification runtime is unavailable in this workspace')
    }
  }

  const identifiable = await findArtistIdentifiableImage(request)
  if (!identifiable) {
    test.skip(true, 'Artist runtime returned only undefined predictions for the clean CI fixture library')
  }
  const { image, artist } = identifiable!

  await openMainPage(page)

  await setGallerySearch(page, image.filename)
  await expect(page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`)).toBeVisible()

  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`).click()

  await openView(page, 'artist')
  await expect(page.locator('#view-artist.active')).toBeVisible()

  await page.locator('#artist-threshold').evaluate((node) => {
    const input = node as HTMLInputElement
    input.value = '0.00'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.locator('#btn-identify-selected').click()

  let finalProgress: any = null
  await expect.poll(async () => {
    const progressResponse = await request.get('/api/artists/batch-progress')
    finalProgress = await progressResponse.json()
    return `${finalProgress.running}:${finalProgress.processed}/${finalProgress.total}:${finalProgress.errors}`
  }, { timeout: 90000 }).toBe('false:1/1:0')

  expect(finalProgress?.results?.[0]?.artist).toBeTruthy()
  expect(finalProgress?.results?.[0]?.artist).not.toBe('undefined')
  await expect(page.locator('#artist-results-grid')).toContainText(formatArtistNameForUi(artist), { timeout: 15000 })
  await expect(page.locator('#artist-stats')).toContainText('Identified')
})

test('auto-separate should honor search and move the matching files', async ({ page, request }) => {
  await resetAutoSeparateFixture()
  await page.addInitScript((search) => {
    localStorage.setItem('autosep_filter_state_v1', JSON.stringify({
      generators: ['comfyui', 'nai', 'webui', 'forge', 'unknown'],
      ratings: ['general', 'sensitive', 'questionable', 'explicit'],
      tags: [],
      checkpoints: [],
      loras: [],
      prompts: [],
      artist: null,
      search,
      minWidth: null,
      maxWidth: null,
      minHeight: null,
      maxHeight: null,
      aspectRatio: '',
      minAesthetic: null,
      maxAesthetic: null,
    }))
  }, 'manual_test_autosep_token_20260405')

  await openMainPage(page)

  await setGallerySearch(page, 'manual_test_autosep_token_20260405')
  await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(2)

  await openSortingSubView(page, 'autosep')
  await page.locator('#autosep-action-mode-panel input[data-autosep-operation-mode][value="move"]').check({ force: true })
  await page.locator('#autosep-destination').fill(autoSepOut)
  await page.locator('#btn-preview-autosep').click()

  await expect(page.locator('#autosep-preview .stat-number')).toHaveText('2')
  await expect(page.locator('#autosep-preview-list')).toContainText('manual-autosep-1.png')
  await expect(page.locator('#autosep-preview-list')).toContainText('manual-autosep-2.png')

  await page.locator('#btn-execute-autosep').click()
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await page.locator('#btn-confirm-ok').click()

  await expect.poll(async () => countFiles(autoSepOut, '.png'), { timeout: 30000 }).toBe(2)

  const movedResponse = await request.get('/api/images?limit=10&search=manual_test_autosep_token_20260405')
  const movedPayload = await movedResponse.json()
  expect(movedPayload.images).toHaveLength(2)
  for (const movedImage of movedPayload.images) {
    expect(String(movedImage.path)).toContain('autosep-out')
  }
})

test('manual sort should honor search and support move, skip, and undo', async ({ page }) => {
  await resetManualSortFixture()
  await page.addInitScript((search) => {
    localStorage.setItem('manual_sort_filter_state_v1', JSON.stringify({
      generators: ['comfyui', 'nai', 'webui', 'forge', 'unknown'],
      ratings: ['general', 'sensitive', 'questionable', 'explicit'],
      tags: [],
      checkpoints: [],
      loras: [],
      prompts: [],
      artist: null,
      search,
      sortBy: 'newest',
      limit: 0,
      minWidth: null,
      maxWidth: null,
      minHeight: null,
      maxHeight: null,
      aspectRatio: '',
      minAesthetic: null,
      maxAesthetic: null,
    }))
  }, 'manual_test_sort_token_20260405')

  await openMainPage(page)

  await setGallerySearch(page, 'manual_test_sort_token_20260405')
  await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(3)

  await openSortingSubView(page, 'manual')

  await page.locator('input[name="manual-sort-operation"][value="move"]').check({ force: true })
  await page.locator('.folder-path-input[data-key="w"]').fill(manualSortTop)
  await page.locator('.folder-path-input[data-key="d"]').fill(manualSortRight)
  await page.locator('.folder-path-input[data-key="s"]').fill(manualSortBottom)
  await page.locator('#btn-start-sorting').click()
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await page.locator('#btn-confirm-ok').click()

  await expect(page.locator('#sort-interface')).toBeVisible()
  await expect(page.locator('#sort-progress-text')).toContainText('0 / 3')

  const initialImage = await page.locator('#current-image').getAttribute('src')
  expect(initialImage).toBeTruthy()

  await page.keyboard.press('D')
  await expect(page.locator('#sort-sorted-count')).toHaveText('1')

  await page.keyboard.press('Z')
  await expect(page.locator('#sort-sorted-count')).toHaveText('0')
  const restoredImage = await page.locator('#current-image').getAttribute('src')
  expect(normalizeImageSrc(restoredImage)).toBe(normalizeImageSrc(initialImage))

  await page.keyboard.press('W')
  await expect(page.locator('#sort-sorted-count')).toHaveText('1')

  const secondImage = await page.locator('#current-image').getAttribute('src')
  expect(secondImage).toBeTruthy()
  expect(normalizeImageSrc(secondImage)).not.toBe(normalizeImageSrc(initialImage))

  await page.keyboard.press('Space')
  await expect(page.locator('#sort-skipped-count')).toHaveText('1')

  await page.keyboard.press('S')
  await expect.poll(async () => countFiles(manualSortTop, '.png'), { timeout: 20000 }).toBe(1)
  await expect.poll(async () => countFiles(manualSortBottom, '.png'), { timeout: 20000 }).toBe(1)
  await expect.poll(async () => countFiles(manualSortRight, '.png'), { timeout: 20000 }).toBe(0)
  await expect.poll(async () => countFiles(manualSortInbox, '.png'), { timeout: 20000 }).toBe(1)
})

test('A/B Showdown should switch modes, compare a pair, pick a winner, and save it', async ({ page, request }) => {
  // v3.3.2 WB-S7: Sort & Cull Workbench A/B Showdown (bracket) flow. Reuses the
  // manual-sort fixture (3 images) and drives the mode switch itself so the
  // slot WASD path (covered by the test above) stays the default.
  await resetManualSortFixture()
  await page.addInitScript((search) => {
    localStorage.setItem('manual_sort_filter_state_v1', JSON.stringify({
      generators: ['comfyui', 'nai', 'webui', 'forge', 'unknown'],
      ratings: ['general', 'sensitive', 'questionable', 'explicit'],
      tags: [],
      checkpoints: [],
      loras: [],
      prompts: [],
      artist: null,
      search,
      sortBy: 'newest',
      limit: 0,
      minWidth: null,
      maxWidth: null,
      minHeight: null,
      maxHeight: null,
      aspectRatio: '',
      minAesthetic: null,
      maxAesthetic: null,
    }))
    // Start in slot mode so the test exercises the switch to bracket.
    localStorage.setItem('manual_sort_mode_v1', 'slot')
  }, 'manual_test_sort_token_20260405')

  await openMainPage(page)

  await setGallerySearch(page, 'manual_test_sort_token_20260405')
  await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(3)

  await openSortingSubView(page, 'manual')

  // Switch to A/B Showdown: bracket button activates, intro shows, slot-only
  // folder config hides.
  await page.locator('.sort-mode-btn[data-sort-mode="bracket"]').click()
  await expect(page.locator('.sort-mode-btn[data-sort-mode="bracket"]')).toHaveClass(/is-active/)
  await expect(page.locator('#sort-bracket-intro')).toBeVisible()
  await expect(page.locator('#view-manual .folder-config')).toBeHidden()

  // Route the winner to Favorites (non-destructive) and snapshot the baseline.
  await page.locator('#bracket-winner-collection').selectOption('fav')
  await clearFavorites(request)
  const baselinePayload = await (await request.get('/api/collections/favorites/ids')).json()
  const baselineFavorites = Number(baselinePayload.count ?? (baselinePayload.image_ids || []).length)

  // Start the showdown — bracket has no move/copy confirmation.
  await page.locator('#btn-start-sorting').click()
  await expect(page.locator('#sort-bracket-interface')).toBeVisible()
  await expect(page.locator('#bracket-progress-text')).toHaveText('0 / 2')
  expect(await page.locator('#bracket-champion-image').getAttribute('src')).toBeTruthy()
  expect(await page.locator('#bracket-challenger-image').getAttribute('src')).toBeTruthy()

  // Keep B (challenger) → promotes + advances to the next comparison.
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#bracket-progress-text')).toHaveText('1 / 2')

  // Keep the current champion → finishes the bracket and returns to setup.
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('#sort-bracket-interface')).toBeHidden()
  await expect(page.locator('#sort-setup')).toBeVisible()
  await expect(page.locator('#toast-container')).toContainText(/Winner|Showdown/i)

  // The winner was saved to Favorites by reference.
  await expect.poll(async () => {
    const payload = await (await request.get('/api/collections/favorites/ids')).json()
    return Number(payload.count ?? (payload.image_ids || []).length)
  }, { timeout: 10000 }).toBe(baselineFavorites + 1)
})

test('Keep/Reject cull should switch modes, keep/reject/skip, and route kept images', async ({ page, request }) => {
  // v3.3.2 FF-1: 留/汰 Keep-Reject cull flow. Reuses the manual-sort fixture
  // (3 images) and drives the mode switch itself so the slot WASD path (covered
  // above) stays the default. Non-destructive: kept images route to Favorites.
  await resetManualSortFixture()
  await page.addInitScript((search) => {
    localStorage.setItem('manual_sort_filter_state_v1', JSON.stringify({
      generators: ['comfyui', 'nai', 'webui', 'forge', 'unknown'],
      ratings: ['general', 'sensitive', 'questionable', 'explicit'],
      tags: [],
      checkpoints: [],
      loras: [],
      prompts: [],
      artist: null,
      search,
      sortBy: 'newest',
      limit: 0,
      minWidth: null,
      maxWidth: null,
      minHeight: null,
      maxHeight: null,
      aspectRatio: '',
      minAesthetic: null,
      maxAesthetic: null,
    }))
    // Start in slot mode so the test exercises the switch to cull.
    localStorage.setItem('manual_sort_mode_v1', 'slot')
  }, 'manual_test_sort_token_20260405')

  await openMainPage(page)

  await setGallerySearch(page, 'manual_test_sort_token_20260405')
  await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(3)

  await openSortingSubView(page, 'manual')

  // Switch to Keep/Reject: cull button activates, intro shows, slot-only folder
  // config hides.
  await page.locator('.sort-mode-btn[data-sort-mode="cull"]').click()
  await expect(page.locator('.sort-mode-btn[data-sort-mode="cull"]')).toHaveClass(/is-active/)
  await expect(page.locator('#sort-cull-intro')).toBeVisible()
  await expect(page.locator('#view-manual .folder-config')).toBeHidden()

  // Route kept images to Favorites (non-destructive) and snapshot the baseline.
  await page.locator('#cull-keep-collection').selectOption('fav')
  await clearFavorites(request)
  const baselinePayload = await (await request.get('/api/collections/favorites/ids')).json()
  const baselineFavorites = Number(baselinePayload.count ?? (baselinePayload.image_ids || []).length)

  // Start culling — cull has no move/copy confirmation.
  await page.locator('#btn-start-sorting').click()
  await expect(page.locator('#sort-cull-interface')).toBeVisible()
  await expect(page.locator('#cull-progress-text')).toHaveText('1 / 3')
  expect(await page.locator('#cull-image').getAttribute('src')).toBeTruthy()

  // Keep (→) the first image → advances; tally increments.
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#cull-progress-text')).toHaveText('2 / 3')
  await expect(page.locator('#cull-tally-keep')).toHaveText('♥ 1')

  // Reject (←) the second → advances; reject tally increments.
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('#cull-progress-text')).toHaveText('3 / 3')
  await expect(page.locator('#cull-tally-reject')).toHaveText('✕ 1')

  // Keep (→) the last → finishes the cull and returns to setup.
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#sort-cull-interface')).toBeHidden()
  await expect(page.locator('#sort-setup')).toBeVisible()
  await expect(page.locator('#toast-container')).toContainText(/Cull|kept|留汰/i)

  // The two kept images were saved to Favorites by reference.
  await expect.poll(async () => {
    const payload = await (await request.get('/api/collections/favorites/ids')).json()
    return Number(payload.count ?? (payload.image_ids || []).length)
  }, { timeout: 10000 }).toBe(baselineFavorites + 2)
})

test('censor detect and save should work through the real UI flow', async ({ page, request }) => {
  test.setTimeout(180000)

  await resetSaveOutputs()
  const modelsResponse = await request.get('/api/censor/models')
  expect(modelsResponse.ok()).toBeTruthy()
  const modelsPayload = await modelsResponse.json()
  const detectionBackends = (modelsPayload.models || []).filter((model: any) =>
    ['legacy', 'nudenet'].includes(String(model?.id || ''))
  )
  const availableDetectionBackend = detectionBackends.find((model: any) => model?.available)
  test.skip(
    !availableDetectionBackend,
    detectionBackends.map((model: any) => model?.message).filter(Boolean).join(' | ')
      || 'No local censor detection backend is ready in this workspace',
  )

  const image = await findDetectableImage(request)
  test.skip(!image, 'No image in the current library produced detectable censor regions with the available backend')

  await openMainPage(page)

  await setGallerySearch(page, image.filename)
  await expect(page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`)).toBeVisible()

  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`).click()
  await page.locator('#btn-send-to-censor').click()

  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(1, { timeout: 15000 })

  await page.locator('#btn-open-detect-modal').click()
  await expect(page.locator('#detect-modal.visible')).toBeVisible()

  await page.locator('#censor-confidence').evaluate((node) => {
    const input = node as HTMLInputElement
    input.value = '0.15'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  await page.locator('#btn-auto-detect-current-modal').click()
  await expect.poll(async () => {
    return await page.locator('#censor-queue-list .queue-thumb-v2.processed').count()
  }, { timeout: 30000 }).toBe(1)
  const detectModal = page.locator('#detect-modal')
  if (await detectModal.isVisible().catch(() => false)) {
    await page.locator('#btn-close-detect-modal').click()
    await expect(detectModal).not.toBeVisible()
  }

  await page.locator('#btn-save-all-processed').click()
  await expect(page.locator('#save-options-modal.visible')).toBeVisible()
  await page.locator('#save-output-folder').fill(saveOutPng)
  await page.selectOption('#save-metadata-option', 'keep')
  await page.selectOption('#save-format-option', 'png')
  await page.locator('#btn-confirm-save-options').click()
  await expect.poll(async () => countFiles(saveOutPng, '.png'), { timeout: 30000 }).toBeGreaterThan(0)

  await page.locator('#btn-save-all-processed').click()
  await expect(page.locator('#save-options-modal.visible')).toBeVisible()
  await page.locator('#save-output-folder').fill(saveOutWebp)
  await page.selectOption('#save-metadata-option', 'strip')
  await page.selectOption('#save-format-option', 'webp')
  await page.locator('#btn-confirm-save-options').click()
  await expect.poll(async () => countFiles(saveOutWebp, '.webp'), { timeout: 30000 }).toBeGreaterThan(0)

  await page.locator('#btn-save-all-processed').click()
  await expect(page.locator('#save-options-modal.visible')).toBeVisible()
  await page.locator('#save-output-folder').fill(saveOutJpg)
  await page.selectOption('#save-metadata-option', 'minimal')
  await page.selectOption('#save-format-option', 'jpg')
  await page.locator('#btn-confirm-save-options').click()
  await expect.poll(async () => countFiles(saveOutJpg, '.jpg'), { timeout: 30000 }).toBeGreaterThan(0)
})

test('scan folder browser should pick a real folder and scan it through the UI', async ({ page, request }) => {
  test.setTimeout(120000)
  resetScanBrowserFixture()

  await openMainPage(page)

  await page.locator('#btn-scan').click()
  await expect(page.locator('#scan-modal.visible')).toBeVisible()
  await page.locator('#scan-folder-path').fill(scanBrowserRoot)
  await page.locator('#btn-browse-folder').click()

  const pickedRow = page.locator('.folder-browser-item').filter({ hasText: 'picked-folder' }).first()
  await expect(pickedRow).toBeVisible({ timeout: 15000 })
  await pickedRow.click()
  await page.locator('#folder-browser-select').click()
  await expect(page.locator('#scan-folder-path')).toHaveValue(scanBrowserPicked)

  await disableScanAutoTag(page)
  await expect(page.locator('#scan-auto-tag')).not.toBeChecked()
  await page.locator('#btn-start-scan').click()

  await expect.poll(async () => {
    const response = await request.get('/api/scan/progress')
    const payload = await response.json()
    return `${payload.status}:${payload.new || 0}:${payload.updated || 0}`
  }, { timeout: 90000 }).toMatch(/^done:(2|0):(0|2)$/)

  const scannedImages = await getImagesByFilenames(request, ['manual-scan-browser-1.png', 'manual-scan-browser-2.png'])
  expect(scannedImages).toHaveLength(2)
  for (const image of scannedImages) {
    expect(String(image.path)).toContain('scan-browser-root')
  }
})

test('tag export and import should roundtrip through the real UI', async ({ page, request }) => {
  test.setTimeout(120000)
  const fixture = prepareTagIoFixture()
  const exportPath = path.join(manualRoot, 'manual-tag-export-roundtrip.json')

  await openMainPage(page)
  await page.locator('#btn-tag').click()
  await expect(page.locator('#tag-modal.visible')).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page.locator('#btn-export-tags-json').click()
  const download = await downloadPromise
  await download.saveAs(exportPath)

  const exportedPayload = JSON.parse(await fs.readFile(exportPath, 'utf8'))
  const exportedFixture = (exportedPayload.images || []).find((item: any) => item.filename === fixture.filename)
  expect(exportedFixture).toBeTruthy()
  expect((exportedFixture.tags || []).some((tag: any) => tag.tag === fixture.expectedTag)).toBeTruthy()

  clearTagsForImage(fixture.imageId)
  await expect.poll(async () => {
    const response = await request.get(`/api/images/${fixture.imageId}`)
    const payload = await response.json()
    return Array.isArray(payload.tags) ? payload.tags.length : -1
  }, { timeout: 10000 }).toBe(0)

  await page.locator('#import-tags-file').setInputFiles(exportPath)
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await page.locator('#btn-confirm-ok').click()
  await expect(page.locator('#toast-container')).toContainText('Imported tags', { timeout: 15000 })

  await expect.poll(async () => {
    const response = await request.get(`/api/images/${fixture.imageId}`)
    const payload = await response.json()
    return (payload.tags || []).map((tag: any) => tag.tag).join(',')
  }, { timeout: 15000 }).toContain(fixture.expectedTag)
})

test('censor batch rename should update preview and apply only selected queue items', async ({ page, request }) => {
  const response = await request.get('/api/images?limit=2&sort_by=newest')
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()
  const images = payload.images.slice(0, 2)
  expect(images).toHaveLength(2)

  await openMainPage(page)

  await page.locator('#btn-toggle-select').click()
  for (const image of images) {
    await expect(page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`)).toBeVisible()
    await page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`).click()
  }
  await page.locator('#btn-send-to-censor').click()

  await expect(page.locator('#view-censor.active')).toBeVisible()
  const thumbs = page.locator('#censor-queue-list .queue-thumb-v2')
  await expect(thumbs).toHaveCount(2, { timeout: 15000 })
  await thumbs.nth(1).click()

  await page.locator('#btn-batch-rename').click()
  await expect(page.locator('#rename-modal.visible')).toBeVisible()
  await expect(page.locator('#rename-only-selected')).toBeChecked()
  await page.locator('#rename-pattern').fill('{original}_review_{n:02d}')
  await expect(page.locator('#rename-preview-list')).toContainText('_review_01.png')
  await page.locator('#btn-apply-rename').click()
  await expect(page.locator('#toast-container')).toContainText('Renamed 1 image', { timeout: 10000 })

  const queueState = await page.evaluate(() => {
    return (window as Window & { __CENSOR_STATE__?: any }).__CENSOR_STATE__?.queue?.map((item: any) => ({
      original: item.originalFilename,
      output: item.outputFilename,
    })) || []
  })

  expect(queueState).toHaveLength(2)
  const renamedItem = queueState.find((item) => item.output.includes('_review_01.png'))
  const untouchedItem = queueState.find((item) => item.output === item.original)
  expect(renamedItem).toBeTruthy()
  expect(untouchedItem).toBeTruthy()
})

test('queue manager should search, reorder, and sync back to the censor sidebar', async ({ page, request }) => {
  const response = await request.get('/api/images?limit=4&sort_by=newest')
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()
  const images = payload.images.slice(0, 4)
  expect(images).toHaveLength(4)

  const targetImage = images[1]

  await openMainPage(page)

  await page.locator('#btn-toggle-select').click()
  for (const image of images) {
    await expect(page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`)).toBeVisible()
    await page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`).click()
  }
  await page.locator('#btn-send-to-censor').click()

  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(4, { timeout: 15000 })
  const initialQueueOrder = await page.locator('#censor-queue-list .queue-thumb-v2').evaluateAll((nodes) =>
    nodes.map((node) => Number(node.getAttribute('data-id')))
  )

  await page.locator('#btn-open-queue-manager').click()
  await expect(page.locator('#queue-solitaire.active')).toBeVisible()
  await expect(page.locator('#qs-filter-summary')).toContainText(
    /No queue filters are active yet|当前还没有启用队列筛选/,
  )

  await page.locator('#qs-filter-gallery').click()
  await expect(page.locator('#qs-filter-summary')).toContainText(
    /Gallery filters were copied|Gallery filters copied|已复制图库筛选/,
  )

  await page.locator('#qs-filter-tag').fill(String(targetImage.generator || 'unknown'))
  await page.locator('#qs-filter-apply').click()
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const state = (window as Window & { QueueSolitaire?: any }).QueueSolitaire?.state
      return state?.filterMatches?.size ?? 0
    })
  }, { timeout: 10000 }).toBeGreaterThan(0)
  await page.locator('#qs-filter-tag').fill('')
  await page.locator('#qs-filter-apply').click()

  await page.locator('#qs-btn-add-section').click()
  await expect(page.locator('#input-modal.visible')).toBeVisible()
  await page.locator('#input-modal-field').fill('Review')
  await page.locator('#btn-input-ok').click()
  await expect(page.locator('#qs-sections .qs-section')).toHaveCount(2)
  await page.locator(`.qs-thumb[data-id="${targetImage.id}"]`).click()
  await page.keyboard.press('2')

  await expect.poll(async () => {
    return await page.evaluate(() => {
      const state = (window as Window & { QueueSolitaire?: any }).QueueSolitaire?.state
      const sections = Array.isArray(state?.sections) ? state.sections : []
      return sections[1]?.items?.[0] ?? null
    })
  }, { timeout: 10000 }).toBe(targetImage.id)

  await page.locator('#qs-btn-done').click()
  await expect(page.locator('#queue-solitaire.active')).toHaveCount(0)

  const syncedQueueOrder = await page.locator('#censor-queue-list .queue-thumb-v2').evaluateAll((nodes) =>
    nodes.map((node) => Number(node.getAttribute('data-id')))
  )
  expect(syncedQueueOrder).toHaveLength(4)
  expect(syncedQueueOrder.at(-1)).toBe(targetImage.id)
  expect(syncedQueueOrder).not.toEqual(initialQueueOrder)
})

test('tagger custom ONNX copy should stay coherent and localized on the real backend', async ({ page }) => {
  test.setTimeout(60000)

  const extractFirstNumber = (value: string | null) => {
    const match = String(value || '').match(/(\d+)/)
    return match ? Number.parseInt(match[1], 10) : null
  }

  await openMainPage(page)

  if ((await page.locator('html').getAttribute('lang')) !== 'zh-CN') {
    await page.locator('#btn-language-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  }

  await page.locator('#btn-tag').click()
  await expect(page.locator('#tag-modal.visible')).toBeVisible()

  await page.locator('#tag-model-select').selectOption('wd-eva02-large-tagger-v3')
  await expect.poll(async () => {
    return (await page.locator('#tag-model-help').textContent()) || ''
  }, { timeout: 15000 }).not.toMatch(/Most accurate overall|Adaptive max-throughput runtime/)

  await page.locator('#tag-model-select').selectOption('custom')
  await page.locator('#tag-model-path').fill('C:/models/custom-model.onnx')
  await page.locator('#tag-tags-path').fill('C:/models/selected_tags.csv')

  let initialRuntimeSummary = ''
  await expect.poll(async () => {
    initialRuntimeSummary = (await page.locator('#tag-runtime-summary').textContent()) || ''
    return initialRuntimeSummary
  }, { timeout: 15000 }).toMatch(/GPU|CPU/)

  await expect(page.locator('#tag-model-help')).not.toContainText(/GPU Preferred|provider/i)
  await expect(page.locator('#tag-gpu-help')).not.toContainText(/GPU Preferred|provider/i)

  let cpuRecommendation: number | null = null
  await expect.poll(async () => {
    cpuRecommendation = extractFirstNumber(await page.locator('#tag-batch-recommendation').textContent())
    return cpuRecommendation
  }, { timeout: 15000 }).not.toBeNull()
  expect(cpuRecommendation).not.toBeNull()
  expect(cpuRecommendation!).toBeLessThanOrEqual(8)

  await page.locator('#tag-runtime-advanced summary').click()
  await expect(page.locator('#tag-runtime-advanced')).toHaveAttribute('open', '')
  await page.locator('#tag-use-gpu').evaluate((node) => {
    const input = node as HTMLInputElement
    input.checked = false
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('#tag-use-gpu')).not.toBeChecked()

  await expect(page.locator('#tag-runtime-summary')).toContainText(/CPU/)
  await expect(page.locator('#tag-model-help')).not.toContainText(/GPU Preferred|provider/i)
  await expect(page.locator('#tag-gpu-help')).toContainText(/CPU/)

  let gpuRecommendation: number | null = null
  await expect.poll(async () => {
    gpuRecommendation = extractFirstNumber(await page.locator('#tag-batch-recommendation').textContent())
    return gpuRecommendation
  }, { timeout: 15000 }).not.toBeNull()
  expect(gpuRecommendation).not.toBeNull()
  expect(gpuRecommendation!).toBeLessThanOrEqual(8)

  await page.locator('#tag-use-gpu').evaluate((node) => {
    const input = node as HTMLInputElement
    input.checked = true
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('#tag-use-gpu')).toBeChecked()
  let reenabledRuntimeSummary = ''
  await expect.poll(async () => {
    reenabledRuntimeSummary = (await page.locator('#tag-runtime-summary').textContent()) || ''
    return reenabledRuntimeSummary
  }, { timeout: 15000 }).toMatch(/GPU|CPU/)
  if (/CPU/.test(reenabledRuntimeSummary) && !/GPU/.test(reenabledRuntimeSummary)) {
    await expect(page.locator('#tag-runtime-detail')).toContainText(/CPU|CUDAExecutionProvider|ONNX/i)
    await expect(page.locator('#tag-gpu-help')).toContainText(/CPU/i)
  } else {
    await expect(page.locator('#tag-runtime-summary')).toContainText(/GPU/)
  }
})

test('scan then tag through the real UI should finish and write tags for the new fixture images', async ({ page, request }) => {
  test.setTimeout(180000)
  prepareTagLiveFixture()

  await openMainPage(page)

  await page.locator('#btn-scan').click()
  await expect(page.locator('#scan-modal.visible')).toBeVisible()
  await page.locator('#scan-folder-path').fill(tagLiveRoot)
  await disableScanAutoTag(page)
  await expect(page.locator('#scan-auto-tag')).not.toBeChecked()
  await page.locator('#btn-start-scan').click()

  await expect.poll(async () => {
    const response = await request.get('/api/scan/progress')
    const payload = await response.json()
    return `${payload.status}:${payload.new || 0}:${payload.updated || 0}`
  }, { timeout: 90000 }).toMatch(/^done:(2|0):(0|2)$/)

  await page.locator('#btn-tag').click()
  await expect(page.locator('#tag-modal.visible')).toBeVisible()
  await page.locator('#tag-model-select').selectOption('wd-swinv2-tagger-v3')
  await page.locator('#btn-start-tag').click()

  let finalProgress: any = null
  await expect.poll(async () => {
    const response = await request.get('/api/tag/progress')
    finalProgress = await response.json()
    return String(finalProgress?.status || '')
  }, { timeout: 120000 }).toMatch(/^(done|error|cancelled)$/)

  if (finalProgress?.status === 'error') {
    const runtimeMessage = String(finalProgress?.message || '')
    test.skip(
      /onnxruntime|No module named|WD14|ONNX/i.test(runtimeMessage),
      runtimeMessage || 'WD14 tagging runtime is unavailable in this workspace',
    )
  }

  expect(`${finalProgress.status}:${finalProgress.total || 0}:${finalProgress.tagged || 0}:${finalProgress.errors || 0}`).toBe('done:2:2:0')

  expect(String(finalProgress?.message || '')).toContain('Completed')

  const taggedImages = await getImagesByFilenames(request, ['manual-tag-live-1.png', 'manual-tag-live-2.png'])
  expect(taggedImages).toHaveLength(2)

  for (const image of taggedImages) {
    const detailResponse = await request.get(`/api/images/${image.id}`)
    expect(detailResponse.ok()).toBeTruthy()
    const detailPayload = await detailResponse.json()
    expect(Array.isArray(detailPayload.tags)).toBeTruthy()
    expect(detailPayload.image?.tagged_at).toBeTruthy()
  }
})
