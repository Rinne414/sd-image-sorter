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

function restoreManualFixtureDbPaths() {
  const script = `
import sqlite3
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = repo_root / "backend" / "images.db"
manual_root = repo_root / ".tmp" / "manual-test"

fixture_paths = {
    "manual-autosep-1.png": manual_root / "autosep-inbox" / "manual-autosep-1.png",
    "manual-autosep-2.png": manual_root / "autosep-inbox" / "manual-autosep-2.png",
    "manual-sort-1.png": manual_root / "manual-sort-inbox" / "manual-sort-1.png",
    "manual-sort-2.png": manual_root / "manual-sort-inbox" / "manual-sort-2.png",
    "manual-sort-3.png": manual_root / "manual-sort-inbox" / "manual-sort-3.png",
}

with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    for filename, target_path in fixture_paths.items():
        cur.execute(
            "UPDATE images SET path = ? WHERE filename = ?",
            (str(target_path.resolve()), filename),
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

async function findDetectableImage(request) {
  const response = await request.get('/api/images?limit=20')
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()

  for (const image of payload.images || []) {
    const detect = await request.post('/api/censor/detect', {
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

test.beforeEach(async ({ page }) => {
  await resetAutoSeparateFixture()
  await resetManualSortFixture()
  restoreManualFixtureDbPaths()
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('artist-guide-seen', 'true')
  })
})

test('censor settings should open, explain model roles, and allow typing the pro prompt', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('.nav-tabs [data-view="censor"]').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()

  await page.locator('#btn-open-detect-modal').click()
  await expect(page.locator('#detect-modal.visible')).toBeVisible()

  await expect(page.locator('#censor-capability-panel')).toContainText('5 built-in privacy classes')
  await expect(page.locator('#censor-capability-panel')).toContainText('Prompt-guided segmentation')

  const promptInput = page.locator('#censor-text-prompt')
  await expect(promptInput).toBeEnabled()
  await promptInput.click()
  await promptInput.pressSequentially('face')
  await expect(promptInput).toHaveValue('face')

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
  await expect(page.locator('#censor-advanced-models-help')).toContainText('advanced fixed-class YOLO')

  const generalModelPath = await page.locator('#censor-model-file option').evaluateAll((options) => {
    const match = options.find((option) => option.textContent?.includes('Advanced test only'))
    return match?.getAttribute('value') || null
  })

  expect(generalModelPath).toBeTruthy()
  await page.selectOption('#censor-model-type', 'legacy')
  await page.selectOption('#censor-model-file', String(generalModelPath))
  await expect(page.locator('#censor-simple-guide')).toContainText('general fixed-class model')
  await expect(page.locator('#censor-simple-guide')).toContainText('not an open-text detector')
  await expect(page.locator('.target-region-check').first()).toBeDisabled()
})

test('artist identify selected should work on a real image', async ({ page, request }) => {
  const image = await getFirstImageBySearch(request, '00043-1027297035')

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await setGallerySearch(page, '00043-1027297035')
  await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(2)

  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`).click()

  await page.locator('.nav-tabs [data-view="artist"]').click()
  await expect(page.locator('#view-artist.active')).toBeVisible()

  await page.locator('#artist-threshold').evaluate((node) => {
    const input = node as HTMLInputElement
    input.value = '0.03'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.locator('#btn-identify-selected').click()

  await expect.poll(async () => {
    const progressResponse = await request.get('/api/artists/batch-progress')
    const progress = await progressResponse.json()
    return `${progress.running}:${progress.processed}/${progress.total}:${progress.errors}`
  }, { timeout: 90000 }).toBe('false:1/1:0')

  await expect(page.locator('#artist-results-grid')).toContainText('Mashiro Shiki', { timeout: 15000 })
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
