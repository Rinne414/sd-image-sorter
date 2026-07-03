import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test } from '@playwright/test'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const runtimeDatabasePath = process.env.SD_IMAGE_SORTER_DB_PATH
  || path.join(repoRoot, 'data', 'images.db')
const reconnectRoot = path.join(repoRoot, '.tmp', 'manual-test', 'reconnect-missing-root')
const oldDir = path.join(reconnectRoot, 'old-folder')
const newRoot = path.join(reconnectRoot, 'new-root')
const newDir = path.join(newRoot, 'new-location')
const reconnectFilename = 'manual-reconnect-moved.png'
const oldImagePath = path.join(oldDir, reconnectFilename)
const newImagePath = path.join(newDir, reconnectFilename)

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

async function openMainPage(page: any) {
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
        (window as any).App
          && typeof (window as any).App.loadImages === 'function'
          && (window as any).Gallery
          && typeof (window as any).Gallery.setImages === 'function'
          && (window as any).App.AppState?.isLoading === false
      )
    })
  }).toBe(true)
}

async function disableScanAutoTag(page: any) {
  await page.locator('#scan-auto-tag').evaluate((node: HTMLInputElement) => {
    node.checked = false
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function resetReconnectFixture() {
  await fs.rm(reconnectRoot, { recursive: true, force: true })
  await fs.mkdir(oldDir, { recursive: true })
  await fs.mkdir(newDir, { recursive: true })

  runBackendScript(`
import sqlite3
from pathlib import Path
from PIL import Image

old_image = Path(${JSON.stringify(oldImagePath)})
old_image.parent.mkdir(parents=True, exist_ok=True)
Image.new("RGB", (96, 96), color=(80, 170, 255)).save(old_image)

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename = ?)", (${JSON.stringify(reconnectFilename)},))
    cur.execute("DELETE FROM images WHERE filename = ?", (${JSON.stringify(reconnectFilename)},))
    conn.commit()
print("ok")
`)
}

async function getImagesByFilename(request: any) {
  const response = await request.get(`/api/images?limit=50&search=${encodeURIComponent(reconnectFilename)}`)
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()
  return (payload.images || []).filter((image: any) => image.filename === reconnectFilename)
}

test('find moved images reconnects a file through the real gallery UI', async ({ page, request }) => {
  test.setTimeout(120000)
  // The 🎲 random / 🔎 reconnect-missing buttons are hidden in the gallery
  // header at < 1500px to free up toolbar space on laptop widths
  // (commit 60ccb1773497877cf5dd9c458423710e59d26c25). Default Playwright
  // 'Desktop Chrome' viewport is 1280×720, which is below that threshold,
  // so this test must explicitly opt into a wider viewport to exercise the
  // desktop primary entry-point. Mobile users still reach reconnect from the
  // hamburger menu, but that path is covered separately.
  await page.setViewportSize({ width: 1600, height: 900 })
  await resetReconnectFixture()

  await openMainPage(page)

  await page.locator('#btn-scan').click()
  await expect(page.locator('#scan-modal.visible')).toBeVisible()
  await page.locator('#scan-folder-path').fill(oldDir)
  await disableScanAutoTag(page)
  await expect(page.locator('#scan-auto-tag')).not.toBeChecked()
  await page.locator('#btn-start-scan').click()

  await expect.poll(async () => {
    const response = await request.get('/api/scan/progress')
    const payload = await response.json()
    return String(payload.status || '')
  }, { timeout: 90000 }).toBe('done')

  await expect.poll(async () => {
    const images = await getImagesByFilename(request)
    return images.length === 1 ? String(images[0].path || '') : ''
  }, { timeout: 15000 }).toContain(oldDir)

  await fs.rename(oldImagePath, newImagePath)
  expect(fsSync.existsSync(oldImagePath)).toBe(false)
  expect(fsSync.existsSync(newImagePath)).toBe(true)

  // The scan-done "what's next" CTA banner floats over the gallery toolbar
  // (since v3.4.3 it carries a third "Create collection" action, wide enough
  // to cover #btn-reconnect-missing at this viewport). The banner is NOT
  // guaranteed: the app deliberately shows a warning toast instead when the
  // scan counted any transient per-file error (app.js scan done-branch), so
  // requiring it here flakes. #btn-start-scan is re-enabled in the same
  // synchronous done-branch that settles banner-vs-toast, and the poll loop
  // stops afterwards — wait for that, then dismiss the banner only if it
  // actually appeared.
  await expect(page.locator('#btn-start-scan')).toBeEnabled({ timeout: 15000 })
  if (await page.locator('#pipeline-next-step.visible').isVisible()) {
    await page.locator('#pipeline-next-step .pns-dismiss').click()
    await expect(page.locator('#pipeline-next-step.visible')).toHaveCount(0)
  }

  await page.locator('#btn-reconnect-missing').click()
  await expect(page.locator('#reconnect-modal.visible')).toBeVisible()
  await page.locator('#reconnect-folder-path').fill(newRoot)
  await page.locator('#btn-browse-reconnect-folder').click()

  const pickedRow = page.locator('#reconnect-folder-browser-container .folder-browser-item').filter({ hasText: 'new-location' }).first()
  await expect(pickedRow).toBeVisible({ timeout: 15000 })
  await pickedRow.click()
  await page.locator('#reconnect-folder-browser-container #folder-browser-select').click()
  await expect(page.locator('#reconnect-folder-path')).toHaveValue(newDir)

  await page.locator('#btn-start-reconnect').click()
  await expect(page.locator('#reconnect-modal.visible')).toHaveCount(0)

  let finalProgress: any = null
  await expect.poll(async () => {
    const response = await request.get('/api/images/reconnect-missing/progress')
    finalProgress = await response.json()
    return `${finalProgress.status}:${finalProgress.matched || 0}:${finalProgress.result?.still_missing ?? ''}:${finalProgress.conflicts || 0}:${finalProgress.ambiguous || 0}`
  }, { timeout: 90000 }).toBe('done:1:0:0:0')

  expect(finalProgress.checked_files).toBeGreaterThanOrEqual(1)

  await expect.poll(async () => {
    const images = await getImagesByFilename(request)
    return images.length === 1 ? String(images[0].path || '') : ''
  }, { timeout: 15000 }).toBe(newImagePath)

  await page.evaluate(async (filename) => {
    const app = (window as any).App
    if (typeof app.updateFilters === 'function') {
      app.updateFilters((filters: any) => {
        filters.search = filename
      })
    } else {
      app.AppState.filters.search = filename
    }
    app.updateFilterSummary()
    await app.loadImages()
  }, reconnectFilename)

  await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(1, { timeout: 15000 })
})
