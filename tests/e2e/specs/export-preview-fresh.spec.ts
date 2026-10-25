import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * GitHub issue #5, checked on today's Batch export dialog with 60 pictures:
 *   - after tagging, the preview shows the new tags without a restart, both
 *     when the dialog is reopened and when tagging ends while it is open;
 *   - changing an export option re-renders every picture, not only the first
 *     50 (the preview must match what will be exported);
 *   - the list holds every selected picture (the old 20-picture limit);
 *   - clicking a picture deep in the list keeps the list where it was;
 *   - with the underscore option on or off, every caption file is named after
 *     its picture, "1 (2)_1.png" -> "1 (2)_1.txt".
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1366, height: 768 } })

const repoRoot = path.resolve(__dirname, '..', '..', '..')

function commandExists(candidate: string): boolean {
  if (candidate.includes(path.sep) || candidate.includes('/')) return fsSync.existsSync(candidate)
  try {
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    return execFileSync(lookup, [candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0
  } catch {
    return false
  }
}

const pythonCandidates = process.platform === 'win32'
  ? [path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'), path.join(repoRoot, 'backend', 'venv', 'bin', 'python'), 'python']
  : [path.join(repoRoot, 'backend', 'venv', 'bin', 'python'), 'python3', 'python', path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe')]
const backendPython = process.env.PW_BACKEND_PYTHON || pythonCandidates.find(commandExists) || pythonCandidates[0]
const databasePath = process.env.SD_IMAGE_SORTER_DB_PATH || path.join(repoRoot, 'data', 'images.db')

const fixtureRoot = path.join(repoRoot, '.tmp', 'issue5-export-fresh')
const outputRoot = path.join(repoRoot, '.tmp', 'issue5-export-out')
const TOKEN = 'issue5_exportfresh_token'
const COUNT = 60
const DEEP = 55 // beyond the first 50 the preview renders up front

function python(script: string): string {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], { cwd: repoRoot, stdio: 'pipe' }).toString('utf8').trim()
}

/** Picture names a trainer pairs by exact basename: spaces, brackets, underscores. */
function fixtureName(index: number): string {
  if (index === 1) return '1 (2)_1.png'
  if (index % 3 === 0) return `char_${index} (v2)_final.png`
  return `${index} (${index})_copy.png`
}

function seed(): number[] {
  const names = Array.from({ length: COUNT }, (_, i) => fixtureName(i + 1))
  return JSON.parse(python(`
import json, shutil, sqlite3
from pathlib import Path
from PIL import Image
root = Path(${JSON.stringify(fixtureRoot)})
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)
names = ${JSON.stringify(names)}
ids = []
with sqlite3.connect(${JSON.stringify(databasePath)}) as conn:
    cur = conn.cursor()
    for index, name in enumerate(names):
        image_path = (root / name).resolve()
        Image.new("RGB", (64, 64), color=(index * 4 % 255, 90, 160)).save(image_path)
        cur.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE path = ?)", (str(image_path),))
        cur.execute("DELETE FROM image_prompt_tokens WHERE image_id IN (SELECT id FROM images WHERE path = ?)", (str(image_path),))
        cur.execute("DELETE FROM images WHERE path = ?", (str(image_path),))
        st = image_path.stat()
        cur.execute(
            """INSERT INTO images (path, filename, generator, prompt, negative_prompt, metadata_json,
                width, height, file_size, source_size, source_mtime_ns, is_readable, read_error,
                metadata_status, created_at)
               VALUES (?, ?, 'unknown', ?, '', NULL, 64, 64, ?, ?, ?, 1, NULL, 'complete', CURRENT_TIMESTAMP)""",
            (str(image_path), name, ${JSON.stringify(TOKEN)}, st.st_size, st.st_size, st.st_mtime_ns),
        )
        image_id = cur.lastrowid
        ids.append(image_id)
        cur.execute("INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)",
                    (image_id, ${JSON.stringify(TOKEN)}.replace('_', ' ')))
        cur.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, '1girl', 0.95)", (image_id,))
        cur.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, 'long_hair', 0.9)", (image_id,))
    conn.commit()
print(json.dumps(ids))
`)) as number[]
}

/** What a finished tagging run does to the database: new tags for a picture. */
function addTag(imageId: number, tag: string) {
  python(`
import sqlite3
with sqlite3.connect(${JSON.stringify(databasePath)}) as conn:
    conn.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, 0.88)", (${imageId}, ${JSON.stringify(tag)}))
    conn.commit()
`)
}

function cleanup() {
  python(`
import shutil, sqlite3
from pathlib import Path
root = Path(${JSON.stringify(fixtureRoot)})
with sqlite3.connect(${JSON.stringify(databasePath)}) as conn:
    like = str(root.resolve()) + "%"
    conn.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE path LIKE ?)", (like,))
    conn.execute("DELETE FROM image_prompt_tokens WHERE image_id IN (SELECT id FROM images WHERE path LIKE ?)", (like,))
    conn.execute("DELETE FROM images WHERE path LIKE ?", (like,))
    conn.commit()
shutil.rmtree(root, ignore_errors=True)
shutil.rmtree(Path(${JSON.stringify(outputRoot)}), ignore_errors=True)
`)
}

let ids: number[] = []

test.beforeAll(() => {
  ids = seed()
  expect(ids.length).toBe(COUNT)
})

test.afterAll(() => cleanup())

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('aurora-entry-skip', '1')
  })
})

async function selectFixtureAndOpenExport(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => page.evaluate(() => Boolean((window as any).App?.loadImages)
    && (window as any).App.AppState?.isLoading === false)).toBe(true)
  const search = page.locator('#gallery-search-input')
  await search.fill(TOKEN)
  await search.press('Enter')
  await expect(page.locator('#gallery-grid .gallery-item[data-id]').first()).toBeVisible({ timeout: 15000 })
  await page.evaluate(async () => { await (window as any).selectAllFilteredResults() })
  await expect.poll(() => page.evaluate(() => (window as any).getSelectedGalleryCount())).toBe(COUNT)
  await page.evaluate(() => (window as any).showBatchExportModal())
  await expect(page.locator('#batch-export-modal')).toBeVisible()
  await page.locator('#batch-export-content-mode').selectOption('tags')
}

/** The underscore option sits in the folded Advanced options; users click its label. */
async function setUnderscores(page: Page, on: boolean) {
  const advanced = page.locator('#batch-export-advanced-options')
  if (!(await advanced.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await advanced.locator('summary').click()
  }
  const box = page.locator('#batch-export-normalize-underscores')
  if ((await box.isChecked()) !== on) {
    await page.locator('label.checkbox-label:has(#batch-export-normalize-underscores)').click()
  }
  await expect.poll(() => box.isChecked()).toBe(on)
}

/** Do something that redraws the preview, and wait until the new one is drawn. */
async function redrawn(page: Page, action: () => Promise<unknown>) {
  await page.evaluate(() => { (window as any).__queueBoxBefore = (window as any).V321Integration._queueScrollContainer })
  await action()
  await expect.poll(() => page.evaluate(() => {
    const box = (window as any).V321Integration._queueScrollContainer
    return Boolean(box && box.isConnected && box !== (window as any).__queueBoxBefore)
  })).toBe(true)
}

/** The picture at this position of the preview list (the list's own order). */
async function idAtPosition(page: Page, position: number): Promise<number> {
  await page.evaluate((i) => {
    const box = (window as any).V321Integration._queueScrollContainer as HTMLElement
    box.scrollTop = Math.max(0, i * 60 - 60)
    box.dispatchEvent(new Event('scroll'))
  }, position)
  await expect.poll(() => page.evaluate((i) => {
    const v = (window as any).V321Integration
    return Number((v.queueSelectionToken ? v.queueIdByIndex.get(i) : v.queueImageIds[i]) || 0)
  }, position)).toBeGreaterThan(0)
  return page.evaluate((i) => {
    const v = (window as any).V321Integration
    return Number(v.queueSelectionToken ? v.queueIdByIndex.get(i) : v.queueImageIds[i])
  }, position)
}

async function renderPreview(page: Page) {
  await page.locator('#btn-refresh-preview').click()
  await expect(page.locator('#export-preview-list .export-preview-queue-item').first()).toBeVisible()
}

/** Scroll the preview list until the picture is drawn, click it, return its caption. */
async function captionOf(page: Page, imageId: number): Promise<string> {
  await expect.poll(() => page.evaluate((id) => (window as any).V321Integration.queueIndexById.has(id), imageId)).toBe(true)
  await page.evaluate((id) => {
    const v = (window as any).V321Integration
    const box = v._queueScrollContainer as HTMLElement
    box.scrollTop = Math.max(0, v.queueIndexById.get(id) * 60 - 60)
    box.dispatchEvent(new Event('scroll'))
  }, imageId)
  const item = page.locator(`#export-preview-list .export-preview-queue-item[data-image-id="${imageId}"]`)
  await expect(item).toBeVisible()
  await item.click()
  const editor = page.locator(`#export-preview-list .export-preview-main-textarea[data-image-id="${imageId}"]`)
  await expect(editor).toBeVisible()
  await expect.poll(() => editor.inputValue()).not.toBe('')
  return editor.inputValue()
}

test('the preview lists every selected picture, not only 20', async ({ page }) => {
  await selectFixtureAndOpenExport(page)
  await renderPreview(page)

  const total = await page.evaluate(() => (window as any).V321Integration.queueTotalCount)
  expect(total).toBe(COUNT)
  expect(await captionOf(page, ids[COUNT - 1])).toContain('1girl')
})

test('tags written after the preview was shown appear when the dialog is opened again', async ({ page }) => {
  await selectFixtureAndOpenExport(page)
  await renderPreview(page)
  const deep = await idAtPosition(page, DEEP)
  expect(await captionOf(page, deep)).not.toContain('tagged later')
  await page.locator('#btn-close-batch-export').click()

  addTag(deep, 'tagged_later')
  await redrawn(page, () => page.evaluate(() => (window as any).showBatchExportModal()))

  expect(await captionOf(page, deep)).toContain('tagged later')
})

test('tags from a tagging run that ends while the dialog is open appear without a restart', async ({ page }) => {
  await selectFixtureAndOpenExport(page)
  await renderPreview(page)
  const deep = await idAtPosition(page, DEEP - 1)
  expect(await captionOf(page, deep)).not.toContain('finished while open')

  addTag(deep, 'finished_while_open')
  await redrawn(page, () => page.evaluate(() => document.dispatchEvent(new CustomEvent('taggingCompleted', { detail: { processed: 1 } }))))

  expect(await captionOf(page, deep)).toContain('finished while open')
})

test('an option change re-renders pictures beyond the first 50 too', async ({ page }) => {
  await selectFixtureAndOpenExport(page)
  await renderPreview(page)
  const deep = await idAtPosition(page, DEEP + 2)
  expect(await captionOf(page, deep)).toContain('long hair')

  await redrawn(page, () => setUnderscores(page, false))

  expect(await captionOf(page, deep)).toContain('long_hair')
})

test('clicking a picture deep in the list keeps the list where it was', async ({ page }) => {
  await selectFixtureAndOpenExport(page)
  await renderPreview(page)
  await captionOf(page, await idAtPosition(page, DEEP))
  const before = await page.evaluate(() => (window as any).V321Integration._queueScrollContainer.scrollTop)
  expect(before).toBeGreaterThan(0)
  const next = await page.evaluate((i) => {
    const v = (window as any).V321Integration
    return Number(v.queueSelectionToken ? v.queueIdByIndex.get(i) : v.queueImageIds[i])
  }, DEEP + 1)

  await page.locator(`#export-preview-list .export-preview-queue-item[data-image-id="${next}"]`).click()

  await expect.poll(() => page.evaluate(() => (window as any).V321Integration._queueScrollContainer.scrollTop)).toBe(before)
})

test('"Open in Dataset Maker" takes the selection there to copy and rename pictures with their captions', async ({ page }) => {
  await selectFixtureAndOpenExport(page)
  await expect(page.locator('.batch-export-dataset-hint')).toContainText('001.png + 001.txt')

  await page.locator('#btn-batch-export-to-dataset').click()

  await expect(page.locator('#batch-export-modal')).not.toHaveClass(/visible/)
  await expect.poll(() => page.evaluate((wanted) => {
    const have = new Set(((window as any).DatasetMaker?.imageIds || []).map(Number))
    return wanted.filter((id: number) => have.has(id)).length
  }, ids)).toBe(COUNT)
  await expect(page.locator('#view-dataset')).toBeVisible()
})

for (const underscores of [true, false]) {
  test(`caption files keep each picture's name with underscore conversion ${underscores ? 'on' : 'off'}`, async ({ page }) => {
    const folder = path.join(outputRoot, underscores ? 'on' : 'off')
    fsSync.rmSync(folder, { recursive: true, force: true })
    fsSync.mkdirSync(folder, { recursive: true })
    await selectFixtureAndOpenExport(page)
    await setUnderscores(page, underscores)
    await page.evaluate((target) => {
      const folderMode = document.querySelector('input[name="batch-export-output-mode"][value="folder"]') as HTMLInputElement | null
      if (folderMode) { folderMode.checked = true; folderMode.dispatchEvent(new Event('change', { bubbles: true })) }
      const input = document.getElementById('batch-export-folder') as HTMLInputElement | null
      if (input) { input.value = target; input.dispatchEvent(new Event('input', { bubbles: true })) }
    }, folder)
    await page.locator('#btn-start-batch-export').click()

    await expect.poll(() => fsSync.readdirSync(folder).filter((n) => n.endsWith('.txt')).length, { timeout: 30000 }).toBe(COUNT)
    const written = new Set(fsSync.readdirSync(folder))
    for (let i = 1; i <= COUNT; i++) {
      expect(written.has(fixtureName(i).replace(/\.png$/, '.txt'))).toBe(true)
    }
    const sample = fsSync.readFileSync(path.join(folder, '1 (2)_1.txt'), 'utf8')
    expect(sample).toContain(underscores ? 'long hair' : 'long_hair')
  })
}
