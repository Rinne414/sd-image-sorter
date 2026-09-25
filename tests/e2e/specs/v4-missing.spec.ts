import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, openLibrary, runBackendScript, seedImages, tmpRoot } from '../fixtures/v4-seed'

/**
 * V4 missing files, on the real backend: two files were moved to another
 * folder and one was deleted. "Find them in another folder" reconnects the
 * moved two; the deleted one's record is cleared. No stubs.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4misstoken'
const PREFIX = 'v4miss-'
const COUNT = 5
const DIR = 'v4-miss'
const MOVED = 'v4-miss-moved'

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  const home = path.join(tmpRoot, DIR)
  const moved = path.join(tmpRoot, MOVED, 'later')
  fs.rmSync(path.join(tmpRoot, MOVED), { recursive: true, force: true })
  fs.mkdirSync(moved, { recursive: true })
  for (const name of [`${PREFIX}00.png`, `${PREFIX}01.png`]) fs.renameSync(path.join(home, name), path.join(moved, name))
  fs.rmSync(path.join(home, `${PREFIX}02.png`))
  // What a rescan does when a file is gone: the record is marked unreadable.
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("UPDATE images SET is_readable = 0 WHERE filename IN (?, ?, ?)", ("${PREFIX}00.png", "${PREFIX}01.png", "${PREFIX}02.png"))
    conn.commit()
print("ok")
`)
})

test.afterAll(() => cleanupImages(PREFIX, [DIR, MOVED]))

async function pathOf(page: Page, filename: string): Promise<string | null> {
  return page.evaluate(async (name) => {
    const res = await fetch(`/api/images?search=${encodeURIComponent(name)}&limit=5`)
    const body = (await res.json()) as { images: { filename: string; path: string }[] }
    return body.images.find((i) => i.filename === name)?.path ?? null
  }, filename)
}

test('moved files are found again in another folder; a deleted one is cleared', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, 2)

  const status = page.getByTestId('library-status')
  await expect(status).toContainText('3 files not found')
  await status.getByRole('button', { name: 'Deal with it…' }).click()

  const dialog = page.getByTestId('missing-dialog')
  await expect(dialog).toBeInViewport()
  const groups = dialog.getByTestId('missing-groups')
  await expect(groups).toContainText(DIR)
  await expect(groups).toContainText('3 images')
  await expect(groups).toContainText('The folder is there, the files are not')

  // search the folder they were moved to (the search goes into subfolders)
  await dialog.getByRole('button', { name: 'Find them in another folder…' }).click()
  const chooser = page.getByTestId('missing-chooser')
  const pathInput = chooser.getByTestId('folder-path')
  await pathInput.fill(path.join(tmpRoot, MOVED))
  await pathInput.press('Enter')
  await expect(pathInput).toHaveValue(path.join(tmpRoot, MOVED))
  await expect(chooser.getByRole('button', { name: 'New folder' })).toHaveCount(0)
  await chooser.getByRole('button', { name: 'Search here (with subfolders)' }).click()
  await expect(chooser).toHaveCount(0)

  await expect(groups).toContainText('1 images', { timeout: 20_000 })
  await expect.poll(() => pathOf(page, `${PREFIX}00.png`)).toBe(path.join(tmpRoot, MOVED, 'later', `${PREFIX}00.png`))

  // the one that is really gone: clearing asks first and deletes no file
  await groups.getByRole('button', { name: 'Clear these records…' }).click()
  await expect(groups).toContainText('Clear these 1 records? The files are already gone')
  await groups.getByRole('button', { name: 'Clear 1' }).click()
  await expect(dialog).toContainText('No missing files.')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await expect(page.getByTestId('result-count')).toHaveText('4 images')
  await expect(status).not.toContainText('files not found')

  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer').getByTestId('job').first()).toContainText('Found 2 again')
})
