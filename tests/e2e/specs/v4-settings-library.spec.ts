import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page, type Route } from '@playwright/test'

import { markModelsReady } from '../fixtures/model-status'
import { dbPath, pageOverflow, repoRoot, runBackendScript, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'
import { PY_DELETE_IMAGES } from '../fixtures/e2e-db'

/**
 * V4 Settings › Library and Settings › Disk & cache (slice 5e), on the real
 * backend and an isolated library of its own: the source folders (a real
 * rescan as a job, removing a folder that is gone), the tag backup (a real
 * export of this library only, then an import that says first how many images
 * it can change and afterwards why it skipped the rest, never touching another
 * library or guessing between same-named images), the
 * danger zone (import in the way named and stopped; the counts; Cancel
 * focused; the library really emptied), the idle check for new images, and
 * the disk page (real sizes, the thumbnail limit including 0).
 *
 * SAFETY: /api/disk/cleanup and /api/disk/runtime/rebuild-core are answered
 * here in every test (a rebuild marker would make the launcher rebuild the
 * venv, which this worktree shares with the main checkout). Clearing only ever
 * runs on this spec's own library.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const LIB = 'lib_v4e2e_libset'
const LIB_NAME = 'V4 e2e settings'
/** A second library: a tag backup made or imported in LIB must never touch it. */
const OTHER = 'lib_v4e2e_libset_other'
const PREFIX = 'v4libset-'
const TAG = 'v4libset_tag'
const DIR = 'v4-libset'
const SRC = path.join(tmpRoot, DIR, 'libset-src')
const GONE = path.join(tmpRoot, DIR, 'libset-gone')
const COUNT = 4
const serverBase = process.env.BASE_URL || `http://127.0.0.1:${process.env.PW_WEB_SERVER_PORT || process.env.SD_IMAGE_SORTER_PORT || '19087'}`

function dropTestLibrary(): void {
  runBackendScript(`
${PY_DELETE_IMAGES}
import shutil, sqlite3
from pathlib import Path
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    for lib in (${JSON.stringify(LIB)}, ${JSON.stringify(OTHER)}):
        delete_images(conn, "library_id = ?", (lib,))
        conn.execute("DELETE FROM library_roots WHERE library_id = ?", (lib,))
        conn.execute("DELETE FROM libraries WHERE id = ?", (lib,))
    conn.execute("DELETE FROM favorite_paths WHERE path_key LIKE ?", ("%${PREFIX}%",))
    conn.commit()
shutil.rmtree(Path(${JSON.stringify(path.join(tmpRoot, DIR))}), ignore_errors=True)
print("ok")
`)
}

/** Four small PNGs in a folder, and a library whose two sources are that folder and one that is gone. */
function seedLibrary(): void {
  runBackendScript(`
import sqlite3, sys
from pathlib import Path
from PIL import Image
sys.path.insert(0, str(Path(${JSON.stringify(repoRoot)}) / "backend"))
from utils.source_paths import indexed_image_path_match_key
src = Path(${JSON.stringify(SRC)})
src.mkdir(parents=True, exist_ok=True)
for i in range(${COUNT}):
    Image.new("RGB", (48 + i * 8, 64), (60 + i * 40, 120, 90)).save(src / f"${PREFIX}{i:02d}.png")
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("INSERT INTO libraries (id, name, is_default) VALUES (?, ?, 0)", (${JSON.stringify(LIB)}, ${JSON.stringify(LIB_NAME)}))
    for i, folder in enumerate([${JSON.stringify(GONE)}, ${JSON.stringify(SRC)}]):
        p = Path(folder).resolve().as_posix()
        conn.execute(
            "INSERT INTO library_roots (path, path_key, library_id, enabled, added_at) VALUES (?, ?, ?, 1, datetime('now', ?))",
            (p, indexed_image_path_match_key(p), ${JSON.stringify(LIB)}, f"-{i} minutes"),
        )
    conn.commit()
print("ok")
`)
}

/** Run SQL on this spec's images, then make the server drop its cached counts (a throwaway row removed through the API). */
function onOurImages(sql: string): void {
  runBackendScript(`
import json, sqlite3, urllib.request
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    ids = [r[0] for r in conn.execute("SELECT id FROM images WHERE library_id = ? AND filename LIKE ? ORDER BY filename", (${JSON.stringify(LIB)}, "${PREFIX}%"))]
    for n, image_id in enumerate(ids):
        for statement in ${JSON.stringify(sql)}.split(";"):
            if statement.strip():
                conn.execute(statement.replace("{id}", str(image_id)).replace("{n}", str(n)))
    cur = conn.execute("INSERT INTO images (path, filename, library_id, is_readable, metadata_status, created_at) VALUES ('/nowhere/${PREFIX}sentinel.png', '${PREFIX}sentinel.png', ?, 1, 'complete', datetime('now'))", (${JSON.stringify(LIB)},))
    sentinel = cur.lastrowid
    conn.commit()
req = urllib.request.Request(${JSON.stringify(serverBase)} + "/api/images/remove-selected", data=json.dumps({"image_ids": [sentinel], "background": False}).encode(), headers={"Content-Type": "application/json", "X-SD-Library-Id": ${JSON.stringify(LIB)}}, method="POST")
urllib.request.urlopen(req, timeout=15).read()
print("ok")
`)
}

/**
 * Images a tag backup must not reach or guess between: two of LIB's sharing one
 * file name, and a tagged one in OTHER. Removed with {@link dropStrangers}.
 */
function seedStrangers(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("INSERT OR IGNORE INTO libraries (id, name, is_default) VALUES (?, 'V4 e2e other', 0)", (${JSON.stringify(OTHER)},))
    rows = [("twin-a", "${PREFIX}twin.png", ${JSON.stringify(LIB)}, None), ("twin-b", "${PREFIX}twin.png", ${JSON.stringify(LIB)}, None), ("other", "${PREFIX}other.png", ${JSON.stringify(OTHER)}, 1)]
    for folder, name, lib, tagged in rows:
        cur = conn.execute("INSERT INTO images (path, filename, library_id, is_readable, metadata_status, created_at, tagged_at) VALUES (?, ?, ?, 1, 'complete', datetime('now'), CASE WHEN ? THEN datetime('now') END)", (f"/nowhere/{folder}/{name}", name, lib, tagged))
        if tagged:
            conn.execute("INSERT INTO tags (image_id, tag, confidence, source) VALUES (?, 'its_own_tag', 0.9, 'manual')", (cur.lastrowid,))
    conn.commit()
print("ok")
`)
}

/** Take the strangers away again (and drop the server's cached counts). */
function dropStrangers(): void {
  runBackendScript(`
${PY_DELETE_IMAGES}
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    delete_images(conn, "filename IN (?, ?)", ("${PREFIX}twin.png", "${PREFIX}other.png"))
    conn.execute("DELETE FROM libraries WHERE id = ?", (${JSON.stringify(OTHER)},))
    conn.commit()
print("ok")
`)
  onOurImages('')
}

function countInDb(sql: string, lib = LIB): number {
  return Number(
    runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    print(conn.execute(${JSON.stringify(sql)}, (${JSON.stringify(lib)},)).fetchone()[0])
`),
  )
}

test.beforeAll(() => {
  dropTestLibrary()
  seedLibrary()
})

test.afterAll(() => dropTestLibrary())

interface DiskStub {
  cleanups: unknown[]
  rebuilds: number
}

/** Cleaning and the runtime rebuild never reach the server. */
async function stubDiskWrites(page: Page): Promise<DiskStub> {
  const stub: DiskStub = { cleanups: [], rebuilds: 0 }
  await page.route('**/api/disk/cleanup', (route: Route) => {
    stub.cleanups.push(route.request().postDataJSON())
    return route.fulfill({ json: { cleaned: [{ key: 'cache', freed_bytes: 2048 }], errors: [] } })
  })
  await page.route('**/api/disk/runtime/rebuild-core', (route: Route) => {
    stub.rebuilds += 1
    return route.fulfill({ json: { scheduled: true, restart_required: true, runtime_environment: {} } })
  })
  return stub
}

let disk: DiskStub

test.beforeEach(async ({ page }) => {
  await markModelsReady(page)
  disk = await stubDiskWrites(page)
})

async function openAt(page: Page, hash: string, theme: 'dark' | 'light' = 'dark') {
  await page.addInitScript(
    ([lib, th]) => {
      if (sessionStorage.getItem('v4e2e-libset-init')) return
      sessionStorage.setItem('v4e2e-libset-init', '1')
      localStorage.setItem('sd-image-sorter-lang', 'en')
      localStorage.setItem('sd-v4-theme', th)
      localStorage.setItem('sd-v4-update-autocheck', '0')
      localStorage.removeItem('sd-v4-auto-refresh')
      localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: lib }))
    },
    [LIB, theme] as const,
  )
  const res = await page.goto(`/v4/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

const rows = (page: Page) => page.getByTestId('root-row')

test('source folders: the live one first, a rescan runs as a job and brings its images, a folder that is gone is removed after a confirm', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/settings/library')
  await expect(page.getByTestId('settings-tab-library')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('roots-summary')).toHaveText('Folders: 2, 1 of them not found')
  await expect(rows(page)).toHaveCount(2)
  // the folder that is still there comes first, even though the gone one was added later
  await expect(rows(page).nth(0)).toContainText('libset-src')
  await expect(rows(page).nth(0)).toContainText('never imported')
  const gone = rows(page).nth(1)
  await expect(gone).toContainText('Folder not found')
  await expect(gone.getByTestId('root-rescan')).toBeDisabled()

  // rescan: a job in the drawer that imports the four images into this library
  await rows(page).nth(0).getByTestId('root-rescan').click()
  await expect(page.getByText('Rescanning libset-src; progress is under Jobs')).toBeVisible()
  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  await expect(job).toContainText(`Imported: ${COUNT} new`, { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect(rows(page).nth(0)).toContainText(`${COUNT} images`)
  await expect(rows(page).nth(0)).toContainText('last imported')
  expect(countInDb(`SELECT COUNT(*) FROM images WHERE library_id = ? AND filename LIKE '${PREFIX}%'`)).toBe(COUNT)

  // remove the gone folder: asked first with Cancel focused; Esc only closes the dialog
  await gone.getByTestId('root-remove').click()
  const dialog = page.getByTestId('root-remove-dialog')
  await expect(dialog).toContainText('stay in the library and the files stay on disk')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/#\/settings\/library$/)
  await gone.getByTestId('root-remove').click()
  await dialog.getByTestId('root-remove-ok').click()
  await expect(rows(page)).toHaveCount(1)
  await expect(page.getByTestId('roots-summary')).toHaveText('Folders: 1')
  // its images were never touched
  expect(countInDb(`SELECT COUNT(*) FROM images WHERE library_id = ?`)).toBe(COUNT)
})

test('every folder that is gone goes at once, after a confirm that counts and lists them; the live one stays', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  runBackendScript(`
import sqlite3, sys
from pathlib import Path
sys.path.insert(0, str(Path(${JSON.stringify(repoRoot)}) / "backend"))
from utils.source_paths import indexed_image_path_match_key
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    for name in ("gone-a", "gone-b", "gone-c"):
        p = (Path(${JSON.stringify(GONE)}) / name).resolve().as_posix()
        conn.execute(
            "INSERT INTO library_roots (path, path_key, library_id, enabled, added_at) VALUES (?, ?, ?, 1, datetime('now'))",
            (p, indexed_image_path_match_key(p), ${JSON.stringify(LIB)}),
        )
    conn.commit()
print("ok")
`)
  await openAt(page, '#/settings/library')
  await expect(page.getByTestId('roots-summary')).toHaveText('Folders: 4, 3 of them not found')
  await page.getByTestId('roots-remove-missing').click()
  const dialog = page.getByTestId('roots-remove-missing-dialog')
  await expect(dialog).toContainText('Stop using the missing folders as sources (3)?')
  await expect(dialog.getByTestId('roots-remove-missing-list').locator('li')).toHaveCount(3)
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog.getByTestId('roots-remove-missing-ok').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Missing source folders removed: 3')).toBeVisible()
  await expect(rows(page)).toHaveCount(1)
  await expect(page.getByTestId('roots-summary')).toHaveText('Folders: 1')
  await expect(page.getByTestId('roots-remove-missing')).toHaveCount(0)
  expect(countInDb(`SELECT COUNT(*) FROM images WHERE library_id = ?`)).toBe(COUNT)
})

test('tag backup: a real export of this library only, then an import that says first how many images it can change and afterwards why it skipped the rest', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  onOurImages(`UPDATE images SET tagged_at = datetime('now') WHERE id = {id}; INSERT INTO tags (image_id, tag, confidence, source) VALUES ({id}, '${TAG}', 0.9, 'manual')`)
  seedStrangers()
  await openAt(page, '#/settings/library')

  const downloading = page.waitForEvent('download')
  await page.getByTestId('tags-export').click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^sd-image-sorter-tags-.+\.json$/)
  type Exported = { count: number; images: { path: string; filename: string; tags: { tag: string }[] }[] }
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8')) as Exported
  // only this library's tagged images: the other library's tagged image is not in the file
  expect(exported.count).toBe(COUNT)
  expect(exported.images.map((i) => i.filename).sort()).toEqual([0, 1, 2, 3].map((i) => `${PREFIX}0${i}.png`))
  expect(exported.images.every((i) => i.tags.some((t) => t.tag === TAG))).toBe(true)
  await expect(page.getByText(`Exported the tags of ${COUNT} images`)).toBeVisible()

  // the tags are lost; the backup brings them back. The file also holds an empty entry, one image listed twice,
  // one whose file name only the other library has, and one whose file name two images here share.
  onOurImages(`DELETE FROM tags WHERE image_id = {id}; UPDATE images SET tagged_at = NULL WHERE id = {id}`)
  const entry = (folder: string, name: string) => ({ path: `/nowhere/moved/${folder}/${name}`, filename: name, tags: [{ tag: TAG, confidence: 0.9 }] })
  const images = [
    ...exported.images,
    exported.images[0],
    entry('elsewhere', `${PREFIX}other.png`),
    entry('elsewhere', `${PREFIX}twin.png`),
    { path: '/nowhere/empty.png', filename: 'empty.png', tags: [] },
  ]
  const file = JSON.stringify({ version: '1.0', count: images.length, images })
  await page.getByTestId('tags-import-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(file) })
  const dialog = page.getByTestId('tags-import-dialog')
  await expect(dialog.getByTestId('tags-import-counts')).toHaveText(`The file holds ${COUNT + 4} images: ${COUNT + 3} with tags or a description; 1 are empty and are skipped.`)
  await expect(dialog).toContainText('Images of this library are matched by path, then by file name.')
  await expect(dialog.getByRole('radio', { name: 'Only fill in images that have no tags yet' })).toBeChecked()
  await dialog.getByTestId('tags-import-ok').click()

  // what it did, and why it skipped the rest; it stays until closed
  const result = dialog.getByTestId('tags-import-result')
  await expect(result).toContainText(`Imported the tags of ${COUNT} images, skipped 3`)
  await expect(result.locator('li')).toHaveText([
    '1 not found in this library: neither the path nor the file name matches',
    '1 have a file name that several images in this library share; it is unclear which one is meant, so they were not imported',
    '1 are listed more than once in the file and were imported once',
  ])
  await expect(dialog.getByTestId('tags-import-close')).toBeFocused()
  expect(countInDb(`SELECT COUNT(*) FROM tags t JOIN images i ON i.id = t.image_id WHERE i.library_id = ? AND t.tag = '${TAG}'`)).toBe(COUNT)
  // the twins were not guessed between, and the other library kept its own tags
  expect(countInDb(`SELECT COUNT(*) FROM images WHERE library_id = ? AND filename = '${PREFIX}twin.png' AND tagged_at IS NOT NULL`)).toBe(0)
  expect(countInDb(`SELECT COUNT(*) FROM tags t JOIN images i ON i.id = t.image_id WHERE i.library_id = ? AND t.tag = '${TAG}'`, OTHER)).toBe(0)
  expect(countInDb(`SELECT COUNT(*) FROM tags t JOIN images i ON i.id = t.image_id WHERE i.library_id = ? AND t.tag = 'its_own_tag'`, OTHER)).toBe(1)
  await dialog.getByTestId('tags-import-close').click()
  await expect(dialog).toHaveCount(0)
  dropStrangers()

  // a file that is not JSON is refused before anything is sent
  await page.getByTestId('tags-import-file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{oops') })
  await expect(page.getByText('This file is not valid JSON.')).toBeVisible()
  await expect(dialog).toHaveCount(0)
})

test('clearing the index: work in the way is named and stopped, the counts come first with Cancel focused, then the library is empty', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  // one rated image and one favourite (the tags came back in the previous test)
  onOurImages(`UPDATE images SET user_rating = CASE WHEN {n} = 0 THEN 4 ELSE user_rating END WHERE id = {id}`)
  const firstId = countInDb(`SELECT MIN(id) FROM images WHERE library_id = ? AND filename LIKE '${PREFIX}%'`)
  const fav = await page.request.post('/api/collections/favorites', { data: { image_id: firstId, favorited: true }, headers: { 'X-SD-Library-Id': LIB } })
  expect(fav.ok()).toBe(true)

  // an import is running: it is named and can be stopped from here
  let scanRunning = true
  const cancels: unknown[] = []
  await page.route('**/api/scan/progress', (route) =>
    scanRunning ? route.fulfill({ json: { status: 'running', run_id: 991, source: 'library_rescan', processed: 3, total: 90 } }) : route.fallback(),
  )
  await page.route('**/api/scan/cancel', (route) => {
    cancels.push(route.request().postDataJSON())
    scanRunning = false
    return route.fulfill({ json: { status: 'cancelling', run_id: 991, source: 'library_rescan' } })
  })
  await openAt(page, '#/settings/library')
  const zone = page.getByTestId('libset-clear')
  await expect(zone).toContainText(`Deletes all ${COUNT} image records of library “${LIB_NAME}”`)
  await zone.getByTestId('clear-index').click()
  const busy = page.getByTestId('clear-busy')
  await expect(busy).toContainText('Importing is still running; stop it before clearing.')
  await expect(page.getByTestId('clear-index-dialog')).toHaveCount(0)
  await busy.getByTestId('clear-stop-scan').click()
  await expect(busy).toHaveCount(0, { timeout: 10_000 })
  expect(cancels).toEqual([{ run_id: 991, source: 'library_rescan' }])

  // the confirm: what goes, what stays, Cancel focused; Esc keeps everything
  await zone.getByTestId('clear-index').click()
  const dialog = page.getByTestId('clear-index-dialog')
  await expect(dialog).toContainText(`Clear the index of library “${LIB_NAME}”?`)
  const facts = dialog.getByTestId('clear-index-facts')
  await expect(facts).toContainText(`This deletes ${COUNT} image records.`)
  await expect(facts).toContainText(`the tags and descriptions of ${COUNT} images and the ratings of 1 images`)
  await expect(facts).toContainText('The 1 favorites are kept by file path')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(countInDb(`SELECT COUNT(*) FROM images WHERE library_id = ?`)).toBe(COUNT)

  await zone.getByTestId('clear-index').click()
  await dialog.getByTestId('clear-index-ok').click()
  await expect(dialog).toHaveCount(0)
  const done = page.getByText(`Cleared library “${LIB_NAME}”: ${COUNT} records deleted`)
  await expect(done).toBeVisible()
  expect(countInDb(`SELECT COUNT(*) FROM images WHERE library_id = ?`)).toBe(0)
  await expect(zone).toContainText('Deletes all 0 image records')
  // the toast leads to the library, which is now empty (and offers an import)
  await page.getByRole('button', { name: 'Go to the library' }).click()
  await expect(page.getByTestId('library-empty')).toBeVisible()
})

test('checking for new images while idle: the switch is remembered; after a minute idle and five minutes it asks; a busy answer stays quiet', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.clock.install()
  const hits: string[] = []
  let answer: { status: number; json: unknown } = { status: 409, json: { detail: 'A scan is already running' } }
  await page.route('**/api/library/auto-refresh', (route) => {
    hits.push(route.request().headers()['x-sd-library-id'] ?? '')
    return route.fulfill(answer)
  })
  await openAt(page, '#/settings/library')
  const toggle = page.getByTestId('auto-refresh')
  await expect(toggle).not.toBeChecked()

  // off: nothing is asked, however long it is idle
  await page.clock.fastForward('06:00')
  await page.waitForTimeout(300)
  expect(hits).toEqual([])

  await toggle.check()
  await expect(page.getByTestId('libset-auto').getByRole('status')).toHaveText('Saved')
  await page.reload()
  await expect(page.getByTestId('auto-refresh')).toBeChecked()

  // not yet five minutes since the page opened: nothing
  await page.clock.fastForward('02:00')
  await page.waitForTimeout(300)
  expect(hits).toEqual([])
  // due: one check for this library; the backend says another import runs, and nothing is shown
  await page.clock.fastForward('03:30')
  await expect.poll(() => hits.length).toBe(1)
  expect(hits[0]).toBe(LIB)
  await page.waitForTimeout(300)
  await expect(page.getByText(/idle check/i)).toHaveCount(0)

  // a real failure is said (once)
  answer = { status: 500, json: { error: 'disk on fire' } }
  await page.clock.fastForward('05:30')
  await expect.poll(() => hits.length).toBe(2)
  await expect(page.getByText(/^The idle check did not start: /)).toBeVisible()
})

test('disk & cache: real sizes, the thumbnail limit takes 0 and says so, cleaning asks about unknown sizes, the rebuild asks first', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  // the general cache's size could not be fully counted
  await page.route('**/api/disk/cache-status', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.safe_to_clean = body.safe_to_clean.map((e: { key: string }) => (e.key === 'cache' ? { ...e, size_complete: false } : e))
    await route.fulfill({ response, json: body })
  })
  await openAt(page, '#/settings/disk')
  await expect(page.getByTestId('disk-index-total')).toContainText('images in all')
  await expect(page.getByTestId('disk-library').filter({ hasText: LIB_NAME })).toContainText('in use')

  // the thumbnail limit: 0 turns it off, a wrong value is refused, the old value comes back
  const input = page.getByTestId('disk-thumb-limit')
  const before = await input.inputValue()
  await input.fill('0')
  await input.press('Enter')
  await expect(page.getByTestId('disk-thumb-note')).toHaveText(/^Saved/)
  await expect(page.getByTestId('disk-thumb-status')).toContainText('The thumbnail cache is off')
  await input.fill('-5')
  await input.press('Enter')
  await expect(page.getByTestId('disk-thumb-note')).toHaveText('Enter a number from 0 to 102400 (MB).')
  await input.fill(before)
  await page.getByTestId('disk-thumb-save').click()
  await expect(page.getByTestId('disk-thumb-status')).toContainText(new RegExp(`[Ll]imit ${before} MB`))

  // cleaning: a ticked cache of unknown size is asked about first (Cancel focused); nothing reaches the server before
  await page.getByTestId('disk-cache-cache').locator('input').check()
  await expect(page.getByTestId('disk-cache-cache')).toContainText('size unknown')
  await page.getByTestId('disk-clean-go').click()
  const unknown = page.getByTestId('disk-clean-unknown')
  await expect(unknown).toContainText('The size of General cache could not be fully counted')
  await expect(unknown.getByRole('button', { name: 'Cancel' })).toBeFocused()
  expect(disk.cleanups).toEqual([])
  await unknown.getByTestId('disk-clean-anyway').click()
  await expect(page.getByText('Freed 2 KB')).toBeVisible()
  expect((disk.cleanups[0] as { keys: string[] }).keys).toContain('cache')

  // the kept folders fold away; the rebuild (advanced) asks first with Cancel focused
  await page.getByTestId('disk-kept').locator('summary').click()
  await expect(page.getByTestId('disk-kept')).toContainText('Models')
  await page.getByTestId('disk-advanced').locator('summary').click()
  await page.getByTestId('disk-rebuild').click()
  const rebuild = page.getByTestId('disk-rebuild-dialog')
  await expect(rebuild).toContainText('only the core packages are reinstalled')
  await expect(rebuild.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  expect(disk.rebuilds).toBe(0)
  await page.getByTestId('disk-rebuild').click()
  await rebuild.getByTestId('disk-rebuild-ok').click()
  await expect(page.getByText('Scheduled. Close the app and start it again to rebuild the runtime.')).toBeVisible()
  expect(disk.rebuilds).toBe(1)
  // the page re-reads the sizes afterwards; that read may still be in flight
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

for (const viewport of VIEWPORTS) {
  test(`library and disk settings fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openAt(page, '#/settings/library', viewport.width === 1920 ? 'light' : 'dark')
    await expect(rows(page).first()).toBeVisible()
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    await expect(page.getByTestId('roots-add')).toBeInViewport({ ratio: 1 })
    await expect(rows(page).first().getByTestId('root-rescan')).toBeInViewport({ ratio: 1 })
    const clear = page.getByTestId('clear-index')
    await clear.scrollIntoViewIfNeeded()
    await expect(clear).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('tags-import')).toBeVisible()

    await page.getByTestId('settings-tab-disk').click()
    await expect(page.getByTestId('disk-thumb-save')).toBeInViewport({ ratio: 1 })
    await page.getByTestId('disk-advanced').locator('summary').click()
    const rebuild = page.getByTestId('disk-rebuild')
    await rebuild.scrollIntoViewIfNeeded()
    await expect(rebuild).toBeInViewport({ ratio: 1 })
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  })
}
