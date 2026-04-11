import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const backendPython = path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe')
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

function runBackendScript(script: string) {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: repoRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

function runBackendJson<T>(script: string): T {
  return JSON.parse(runBackendScript(script)) as T
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

function normalizeImageSrc(value: string | null) {
  return String(value || '').split('?')[0]
}

async function resetAutoSeparateFixture() {
  await ensureDir(autoSepInbox)
  await ensureDir(autoSepOut)
  await moveFilesBack(autoSepOut, autoSepInbox)
  await clearDir(autoSepOut)
}

async function resetManualSortFixture() {
  await ensureDir(manualSortInbox)
  for (const dir of [manualSortTop, manualSortLeft, manualSortRight, manualSortBottom]) {
    await ensureDir(dir)
    await moveFilesBack(dir, manualSortInbox)
    await clearDir(dir)
  }
}

async function resetSaveOutputs() {
  for (const dir of [saveOutPng, saveOutWebp, saveOutJpg]) {
    await clearDir(dir)
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

db_path = repo_root / "backend" / "images.db"
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

db_path = repo_root / "backend" / "images.db"
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
db_path = repo_root / "backend" / "images.db"
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

db_path = repo_root / "backend" / "images.db"
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
db_path = repo_root / "backend" / "images.db"
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
db_path = repo_root / "backend" / "images.db"
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
        width = None
        height = None

        if target_path.exists():
            with Image.open(target_path) as image:
                width, height = image.size

        cur.execute(
            "UPDATE images SET path = ?, prompt = ?, file_size = ?, width = ?, height = ? WHERE filename = ?",
            (str(target_path), prompt, file_size, width, height, filename),
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
                    created_at
                ) VALUES (?, ?, 'unknown', ?, '', NULL, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (str(target_path), filename, prompt, width, height, file_size),
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
    window.App.AppState.filters.search = value
    window.App.updateFilterSummary()
    await window.App.loadImages()
  }, search)
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

  throw new Error('Could not find a detectable censor test image in the current library')
}

async function findSam3PromptMatch(request) {
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

  throw new Error('Could not find an artist-identifiable test image in the current library')
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
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('#btn-toggle-select').click()
  const selectionPanel = page.locator('.filter-sidebar #selection-actions')
  const sidebar = page.locator('.filter-sidebar')

  await expect(selectionPanel).toBeVisible()
  await expect(selectionPanel).toContainText('Selection mode is on')

  const panelBox = await selectionPanel.boundingBox()
  const sidebarBox = await sidebar.boundingBox()
  expect(panelBox).not.toBeNull()
  expect(sidebarBox).not.toBeNull()
  expect(panelBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x - 1)
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width + 1)
})

test('censor queue warning should fire once even after re-entering the tab', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

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

  await page.locator('.nav-tabs [data-view="censor"]').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await page.locator('.nav-tabs [data-view="gallery"]').click()
  await expect(page.locator('#view-gallery.active')).toBeVisible()
  await page.locator('.nav-tabs [data-view="censor"]').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await page.locator('.nav-tabs [data-view="similar"]').click()
  await expect(page.locator('#view-similar.active')).toBeVisible()
  await page.locator('.nav-tabs [data-view="censor"]').click()
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
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('.nav-tabs [data-view="censor"]').click()
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
  await expect(promptInput).toBeEnabled()
  await promptInput.click()
  await promptInput.pressSequentially('face')
  await expect(promptInput).toHaveValue('face')
  await expect(page.locator('#btn-segment-text-current')).toBeEnabled()

  await page.selectOption('#censor-model-type', 'nudenet')
  await expect(page.locator('#censor-simple-guide')).toContainText('NudeNet')
  await expect(page.locator('#censor-simple-guide')).toContainText('no text prompt')

  const defaultOptionTexts = await page.locator('#censor-model-file option').allTextContents()
  expect(defaultOptionTexts.some((text) => text.includes('Advanced test only'))).toBeFalsy()
  await page.locator('#censor-show-advanced-models').evaluate((node) => {
    const input = node as HTMLInputElement
    input.checked = true
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('#censor-advanced-models-help')).toContainText(/advanced fixed-class YOLO|segmentation experiments/i)

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

  const { image, prompt } = await findSam3PromptMatch(request)

  await page.goto('/')
  await page.waitForLoadState('networkidle')

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
  await promptInput.fill('')
  await promptInput.pressSequentially(prompt)
  await page.locator('#btn-segment-text-current').click()

  await expect.poll(async () => {
    return await page.locator('#censor-queue-list .queue-thumb-v2.processed').count()
  }, { timeout: 60000 }).toBe(1)
  await expect(page.locator('#toast-container')).toContainText('Applied SAM3 mask', { timeout: 10000 })
})

test('artist identify selected should work on a real image', async ({ page, request }) => {
  const { image, artist } = await findArtistIdentifiableImage(request)

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await setGallerySearch(page, image.filename)
  await expect(page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`)).toBeVisible()

  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`).click()

  await page.locator('.nav-tabs [data-view="artist"]').click()
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

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await setGallerySearch(page, 'manual_test_autosep_token_20260405')
  await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(2)

  await page.locator('.nav-tabs [data-view="autosep"]').click()
  await expect(page.locator('#view-autosep.active')).toBeVisible()
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

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await setGallerySearch(page, 'manual_test_sort_token_20260405')
  await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(3)

  await page.locator('.nav-tabs [data-view="manual"]').click()
  await expect(page.locator('#view-manual.active')).toBeVisible()

  await page.locator('.folder-path-input[data-key="w"]').fill(manualSortTop)
  await page.locator('.folder-path-input[data-key="d"]').fill(manualSortRight)
  await page.locator('.folder-path-input[data-key="s"]').fill(manualSortBottom)
  await page.locator('#btn-start-sorting').click()

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

test('censor detect and save should work through the real UI flow', async ({ page, request }) => {
  test.setTimeout(180000)

  await resetSaveOutputs()
  const image = await findDetectableImage(request)

  await page.goto('/')
  await page.waitForLoadState('networkidle')

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

// Skip: this test depends on a Python fixture (PIL) creating temporary files, which
// is unreliable in CI environments where the backend venv may use a different Python.
test.skip('scan folder browser should pick a real folder and scan it through the UI', async ({ page, request }) => {
  test.setTimeout(120000)
  resetScanBrowserFixture()

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('#btn-scan').click()
  await expect(page.locator('#scan-modal.visible')).toBeVisible()
  await page.locator('#scan-folder-path').fill(scanBrowserRoot)
  await page.locator('#btn-browse-folder').click()

  const pickedRow = page.locator('.folder-browser-item').filter({ hasText: 'picked-folder' }).first()
  await expect(pickedRow).toBeVisible({ timeout: 15000 })
  await pickedRow.click()
  await page.locator('#folder-browser-select').click()
  await expect(page.locator('#scan-folder-path')).toHaveValue(scanBrowserPicked)

  await page.locator('label:has(#scan-auto-tag) .checkbox-custom').click()
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

  await page.goto('/')
  await page.waitForLoadState('networkidle')
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

  await page.goto('/')
  await page.waitForLoadState('networkidle')

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
  expect(queueState[0].output).toBe(queueState[0].original)
  expect(queueState[1].output).toContain('_review_01.png')
  await expect(page.locator('#censor-filename')).toContainText('_review_01.png')
})

test('scan then tag through the real UI should finish and write tags for the new fixture images', async ({ page, request }) => {
  test.setTimeout(180000)
  prepareTagLiveFixture()

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('#btn-scan').click()
  await expect(page.locator('#scan-modal.visible')).toBeVisible()
  await page.locator('#scan-folder-path').fill(tagLiveRoot)
  await page.locator('label:has(#scan-auto-tag) .checkbox-custom').click()
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
    return `${finalProgress.status}:${finalProgress.total || 0}:${finalProgress.tagged || 0}:${finalProgress.errors || 0}`
  }, { timeout: 120000 }).toBe('done:2:2:0')

  expect(String(finalProgress?.message || '')).toContain('Completed')

  const taggedImages = await getImagesByFilenames(request, ['manual-tag-live-1.png', 'manual-tag-live-2.png'])
  expect(taggedImages).toHaveLength(2)

  for (const image of taggedImages) {
    const detailResponse = await request.get(`/api/images/${image.id}`)
    expect(detailResponse.ok()).toBeTruthy()
    const detailPayload = await detailResponse.json()
    expect(Array.isArray(detailPayload.tags)).toBeTruthy()
    expect(detailPayload.tags.length).toBeGreaterThan(0)
  }
})
