/**
 * Repair review — per-candidate pixel verdict (T5b).
 *
 * The listing says whether a candidate's stored pixel fingerprint matches the
 * found file ("pixels match" / "pixels differ"; nothing when unknown). Picking
 * a candidate whose pixels differ asks once through the shared confirm dialog
 * and never blocks; picking a matching one relinks straight away.
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
const fixtureRoot = path.join(repoRoot, '.tmp', 'manual-test', 'repair-review-pixels')
const filename = 'pixels-review.png'
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

/** One pending review: candidate A remembers the found pixels, B remembers other pixels. */
function seedReview(): { a: number; b: number; found: string } {
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
found = root / "found" / ${JSON.stringify(filename)}
other = root / "other" / "other.png"
for target, color in ((found, "crimson"), (other, "navy")):
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (96, 96), color=color).save(target)
found_digest = compute_image_content_fingerprint(str(found))
other_digest = compute_image_content_fingerprint(str(other))

with db.get_db() as conn:
    conn.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename = ?)", (${JSON.stringify(filename)},))
    conn.execute("DELETE FROM images WHERE filename = ?", (${JSON.stringify(filename)},))
    conn.execute("DELETE FROM reconnect_reviews WHERE filename = ?", (${JSON.stringify(filename)},))

stat = found.stat()
ids = []
for folder, digest in (("old-a", found_digest), ("old-b", other_digest)):
    ids.append(db.add_image(
        path=str(root / folder / ${JSON.stringify(filename)}),
        filename=${JSON.stringify(filename)},
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
        content_fingerprint=digest,
        is_readable=False,
        read_error="File not found",
        metadata_status="error",
    ))
db.add_reconnect_review(
    filename=${JSON.stringify(filename)},
    found_path=str(found),
    candidate_ids=ids,
    candidate_count=len(ids),
    run_started_at=1000.0,
)
print(json.dumps({"a": ids[0], "b": ids[1], "found": str(found)}))
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
      && (window as any).App.AppState?.isLoading === false
      && (window as any).RepairReview,
  ))).toBe(true)
}

async function openReview(page: any) {
  await page.evaluate(() => (window as any).RepairReview.open())
  await expect(page.locator('#repair-review-modal.visible')).toBeVisible()
  const row = page.locator('#repair-review-list .repair-review-item')
  await expect(row).toHaveCount(1, { timeout: 10000 })
  // Screenshots are for the owner: wait for the preview and the open transition.
  await expect.poll(async () => row.locator('img.repair-review-thumb').evaluate(
    (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
  )).toBe(true)
  await settle(page)
  return row
}

async function settle(page: any) {
  await page.waitForTimeout(450)
}

function shotPath(testInfo: any, name: string): string {
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true })
    return path.join(shotDir, name)
  }
  return testInfo.outputPath(name)
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  test(`pixel verdicts and the mismatch confirm at ${viewport.width}x${viewport.height}`, async ({ page, request }, testInfo) => {
    test.setTimeout(90000)
    await page.setViewportSize(viewport)
    const seeded = seedReview()

    const listing = await (await request.get('/api/images/repair-candidates')).json()
    const verdicts = Object.fromEntries(listing.items[0].candidates.map((c: any) => [c.image_id, c.pixels_match]))
    expect(verdicts).toEqual({ [seeded.a]: true, [seeded.b]: false })

    await openMainPage(page, 'en')
    const row = await openReview(page)
    const candidates = row.locator('.repair-review-candidate')
    await expect(candidates).toHaveCount(2)
    await expect(candidates.nth(0).locator('.repair-review-candidate-detail')).toContainText('pixels match')
    await expect(candidates.nth(1).locator('.repair-review-candidate-detail')).toContainText('pixels differ')

    // No horizontal overflow inside the modal at this width.
    const overflow = await page.evaluate(() => {
      const shell = document.querySelector('#repair-review-modal .repair-review-shell') as HTMLElement
      return shell ? shell.scrollWidth - shell.clientWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(0)

    await page.screenshot({ path: shotPath(testInfo, `repair-review-pixels-same-${viewport.width}.png`) })

    await candidates.nth(1).locator('input[type="radio"]').check()
    await settle(page)
    await page.screenshot({ path: shotPath(testInfo, `repair-review-pixels-differ-${viewport.width}.png`) })

    // A differing candidate asks first and never blocks.
    await row.locator('.btn-primary').click()
    await expect(page.locator('#confirm-modal.visible')).toBeVisible()
    await expect(page.locator('#confirm-title')).toHaveText('Relink a record whose pixels differ?')
    await settle(page)
    await page.screenshot({ path: shotPath(testInfo, `repair-review-pixels-confirm-${viewport.width}.png`) })
    await page.locator('#btn-confirm-cancel').click()
    await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)
    await expect(row).toHaveCount(1)
    expect((await (await request.get('/api/images/repair-candidates')).json()).total).toBe(1)

    // The matching candidate relinks straight away.
    await candidates.nth(0).locator('input[type="radio"]').check()
    await row.locator('.btn-primary').click()
    await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)
    await expect(page.locator('#repair-review-list .repair-review-item')).toHaveCount(0, { timeout: 10000 })
    expect((await (await request.get('/api/images/repair-candidates')).json()).total).toBe(0)
  })
}

test('the verdicts and the confirm read in Chinese at 1920x1080', async ({ page }, testInfo) => {
  test.setTimeout(90000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  seedReview()

  await openMainPage(page, 'zh-CN')
  const row = await openReview(page)
  const candidates = row.locator('.repair-review-candidate')
  await expect(candidates.nth(0).locator('.repair-review-candidate-detail')).toContainText('像素相同')
  await expect(candidates.nth(1).locator('.repair-review-candidate-detail')).toContainText('像素不同')
  await candidates.nth(1).locator('input[type="radio"]').check()
  await settle(page)
  await page.screenshot({ path: shotPath(testInfo, 'repair-review-pixels-differ-zh-1920.png') })

  await row.locator('.btn-primary').click()
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await expect(page.locator('#confirm-title')).toHaveText('像素不同，仍要重连？')
  await settle(page)
  await page.screenshot({ path: shotPath(testInfo, 'repair-review-pixels-confirm-zh-1920.png') })
  await page.locator('#btn-confirm-cancel').click()
  await expect(row).toHaveCount(1)
})
