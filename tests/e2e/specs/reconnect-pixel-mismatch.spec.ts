/**
 * Find Moved Files — the pixel-mismatch summary line and the progress text (T5b).
 *
 * A missing record whose stored pixels differ from a same-name, same-size file
 * found nearby is not relinked; the result panel says so in one sentence. The
 * progress text under the bar is dynamic: once the search is done, closing
 * and reopening the modal (or an i18n re-apply) must not reset it to the
 * static "Starting search..." key.
 *
 * Screenshots for the owner land in T5B_SHOT_DIR (or testInfo.outputPath).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test } from '../fixtures/click-ledger'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const backendRoot = path.join(repoRoot, 'backend')
const runtimeDatabasePath = process.env.SD_IMAGE_SORTER_DB_PATH
  || path.join(repoRoot, 'data', 'images.db')
const fixtureRoot = path.join(repoRoot, '.tmp', 'manual-test', 'reconnect-pixel-mismatch')
const filename = 'pixels-note.png'
const shotDir = process.env.T5B_SHOT_DIR || ''

const backendPythonCandidates = process.platform === 'win32' ? [
  path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
  'python',
] : [
  path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
  'python3',
]
const backendPython = process.env.PW_BACKEND_PYTHON
  || backendPythonCandidates.find((candidate) => fs.existsSync(candidate) || !candidate.includes(path.sep))
  || backendPythonCandidates[0]

function runBackendScript(script: string): string {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: backendRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

/** One missing record (pixels of another picture) and a same-name, same-size
 *  file 1 s away in mtime under the folder the search will be pointed at. */
function seedMismatch(): { id: number; folder: string } {
  const output = runBackendScript(`
import json, sys
sys.path.insert(0, ${JSON.stringify(backendRoot)})
from pathlib import Path
from PIL import Image
import database as db
from image_fingerprint import compute_image_content_fingerprint

db.DATABASE_PATH = ${JSON.stringify(runtimeDatabasePath)}
db._pragmas_initialized = set()
db.init_db()

root = Path(${JSON.stringify(fixtureRoot)})
found = root / "scan-here" / ${JSON.stringify(filename)}
other = root / "other" / "other.png"
for target, color in ((found, "crimson"), (other, "navy")):
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (96, 96), color=color).save(target, compress_level=0)

with db.get_db() as conn:
    conn.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename = ?)", (${JSON.stringify(filename)},))
    conn.execute("DELETE FROM images WHERE filename = ?", (${JSON.stringify(filename)},))
    conn.execute("DELETE FROM reconnect_reviews WHERE filename = ?", (${JSON.stringify(filename)},))

stat = found.stat()
image_id = db.add_image(
    path=str(root / "gone" / ${JSON.stringify(filename)}),
    filename=${JSON.stringify(filename)},
    metadata_json="{}",
    file_size=stat.st_size,
    source_size=stat.st_size,
    source_mtime_ns=stat.st_mtime_ns + 1_000_000_000,
    content_fingerprint=compute_image_content_fingerprint(str(other)),
    is_readable=False,
    read_error="File not found",
    metadata_status="error",
)
print(json.dumps({"id": image_id, "folder": str(found.parent)}))
`)
  return JSON.parse(output.split('\n').pop() || '{}')
}

async function openMainPage(page: any, lang: 'en' | 'zh-CN') {
  await page.addInitScript((language: string) => {
    localStorage.setItem('sd-image-sorter-lang', language)
  }, lang)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect.poll(async () => page.evaluate(() => Boolean(
    (window as any).App
      && typeof (window as any).App.loadImages === 'function'
      && (window as any).App.AppState?.isLoading === false,
  ))).toBe(true)
}

async function openReconnectModal(page: any) {
  // #btn-reconnect-missing is hidden below 1500px; the modal itself is not.
  await page.evaluate(() => (window as any).App.showModal('reconnect-modal'))
  await expect(page.locator('#reconnect-modal.visible')).toBeVisible()
}

async function closeReconnectModal(page: any) {
  await page.evaluate(() => (window as any).App.hideModal('reconnect-modal'))
  await expect(page.locator('#reconnect-modal.visible')).toHaveCount(0)
}

function shotPath(testInfo: any, name: string): string {
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true })
    return path.join(shotDir, name)
  }
  return testInfo.outputPath(name)
}

async function settle(page: any) {
  await page.waitForTimeout(450)
}

test('the result says how many records were not relinked because the pixels differ', async ({ page, request }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  const seeded = seedMismatch()

  await openMainPage(page, 'en')
  await openReconnectModal(page)
  await page.locator('#reconnect-folder-path').fill(seeded.folder)
  await page.locator('#btn-start-reconnect').click()

  let progress: any = null
  await expect.poll(async () => {
    progress = await (await request.get('/api/images/reconnect-missing/progress')).json()
    return String(progress.status || '')
  }, { timeout: 90000 }).toBe('done')
  expect(progress.pixel_mismatch).toBe(1)
  expect(progress.result.pixel_mismatch).toBe(1)
  expect(progress.matched).toBe(0)

  // Starting the search closes the modal; the result panel is there on reopen.
  await expect(page.locator('#reconnect-modal.visible')).toHaveCount(0)
  await openReconnectModal(page)
  const note = page.locator('#reconnect-result-panel .reconnect-result-note')
  await expect(note).toBeVisible({ timeout: 10000 })
  await expect(note).toHaveText('Records not relinked because the pixels differ: 1 (a same-name, same-size file was found for each).')
  await expect(page.locator('#reconnect-progress-text')).not.toHaveText('Starting search...')
  await expect(page.locator('#reconnect-progress-text')).toHaveText('Records relinked: 0 · still missing: 1')
  const doneText = await page.locator('#reconnect-progress-text').textContent()
  await settle(page)
  await page.screenshot({ path: shotPath(testInfo, 'reconnect-pixel-mismatch-summary-1920.png') })

  // Close, reopen, and force the i18n re-apply: the dynamic text survives.
  await closeReconnectModal(page)
  await openReconnectModal(page)
  await page.evaluate(() => {
    (window as any).UIRefresh?.applyTranslations?.()
    document.body.appendChild(document.createElement('div'))
  })
  await page.waitForTimeout(600)
  await expect(page.locator('#reconnect-progress-text')).toHaveText(doneText || '')
  await expect(note).toHaveText('Records not relinked because the pixels differ: 1 (a same-name, same-size file was found for each).')

  await page.setViewportSize({ width: 1366, height: 768 })
  await settle(page)
  await expect(note).toBeVisible()
  await page.screenshot({ path: shotPath(testInfo, 'reconnect-pixel-mismatch-summary-1366.png') })

  // The record is still missing and untouched.
  const row = await (await request.get(`/api/images/${seeded.id}`)).json().catch(() => null)
  if (row && row.path) {
    expect(String(row.path)).toContain('gone')
  }
})

test('the summary reads in Chinese', async ({ page, request }, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  const seeded = seedMismatch()

  await openMainPage(page, 'zh-CN')
  await openReconnectModal(page)
  await page.locator('#reconnect-folder-path').fill(seeded.folder)
  await page.locator('#btn-start-reconnect').click()
  await expect.poll(async () => {
    const progress = await (await request.get('/api/images/reconnect-missing/progress')).json()
    return String(progress.status || '')
  }, { timeout: 90000 }).toBe('done')

  await openReconnectModal(page)
  const note = page.locator('#reconnect-result-panel .reconnect-result-note')
  await expect(note).toHaveText('有 1 条记录找到了同名同大小的文件，但像素不同，没有自动接上。')
  await expect(page.locator('#reconnect-progress-text')).not.toHaveText('正在开始查找...')
  // The finish text is built from message_key + counts, not the backend's English string.
  const progressText = page.locator('#reconnect-progress-text')
  await expect(progressText).toHaveText('已找回 0 张 · 仍缺失 1 张')
  await settle(page)
  await page.screenshot({ path: shotPath(testInfo, 'reconnect-pixel-mismatch-summary-zh-1920.png') })

  // A translation re-apply must not turn it back into the static key text.
  await page.evaluate(() => {
    (window as any).UIRefresh?.applyTranslations?.()
    document.body.appendChild(document.createElement('div'))
  })
  await page.waitForTimeout(600)
  await expect(progressText).toHaveText('已找回 0 张 · 仍缺失 1 张')
  await page.setViewportSize({ width: 1366, height: 768 })
  await settle(page)
  await page.screenshot({ path: shotPath(testInfo, 'reconnect-pixel-mismatch-summary-zh-1366.png') })
})
