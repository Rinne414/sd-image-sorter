import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, openLibrary, seedImages, tmpRoot } from '../fixtures/v4-seed'

/**
 * The folder browser (move / copy / find missing) opens at a start folder
 * whose listing can arrive late. Typing a path before it arrives must keep
 * what was typed: the late listing may fill the folder list, never the box.
 *
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4fchtoken'
const PREFIX = 'v4fch-'
const DIR = 'v4-fch'
const DEST = 'v4-fch-dest'
const LATE_MS = 1500

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: 2, dir: DIR })
  fs.mkdirSync(path.join(tmpRoot, DEST), { recursive: true })
})

test.afterAll(() => cleanupImages(PREFIX, [DIR, DEST]))

/** Hold back the first folder listing; returns a flag that turns true once it was answered. */
async function delayFirstListing(page: Page): Promise<() => boolean> {
  let delayed = false
  let answered = false
  await page.route('**/api/browse-folder', async (route) => {
    if (delayed) return route.continue()
    delayed = true
    await new Promise((resolve) => setTimeout(resolve, LATE_MS))
    await route.continue()
    answered = true
  })
  return () => answered
}

async function openMoveDialog(page: Page) {
  await openLibrary(page, TOKEN, 2)
  await page.getByTestId('tile').first().click({ modifiers: ['Control'] })
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Move to…' }).click()
  await expect(page.getByTestId('folder-picker')).toBeVisible()
}

test('a path typed before the start folder lists is kept, and Enter opens it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const answered = await delayFirstListing(page)
  await openMoveDialog(page)
  const input = page.getByTestId('folder-path')
  const dest = path.join(tmpRoot, DEST)

  await input.fill(dest)
  expect(answered()).toBe(false)
  await expect.poll(answered, { timeout: LATE_MS + 3000 }).toBe(true)
  // the late start listing did not write into the box
  await expect(input).toHaveValue(dest)
  await input.press('Enter')
  await expect(page.getByTestId('folder-target')).toContainText(dest)
  await page.keyboard.press('Escape')
})

test('in the box while it lists: the start folder arrives selected, so typing replaces it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const answered = await delayFirstListing(page)
  await openMoveDialog(page)
  const input = page.getByTestId('folder-path')
  const dest = path.join(tmpRoot, DEST)

  await input.focus()
  await expect.poll(answered, { timeout: LATE_MS + 3000 }).toBe(true)
  await expect(input).toHaveValue(path.join(tmpRoot, DIR))
  // typing replaces the whole start path instead of being glued onto its end
  await page.keyboard.type(dest)
  await expect(input).toHaveValue(dest)
  await input.press('Enter')
  await expect(page.getByTestId('folder-target')).toContainText(dest)
})

test('an empty or broken folder listing says so in plain words; Try again lists the start folder', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  // the start folder and the drive list it falls back to both answer empty, then {} (no folder list)
  let blank = true
  let answers = 0
  await page.route('**/api/browse-folder', (route) => {
    answers += 1
    if (!blank) return route.continue()
    return answers === 1 ? route.fulfill({ status: 204, body: '' }) : route.fulfill({ json: {} })
  })
  await openMoveDialog(page)
  const dialog = page.getByTestId('folder-picker')
  const alert = dialog.getByRole('alert')
  await expect(alert).toContainText('incomplete')
  await expect(alert).not.toContainText(/Cannot read|undefined/)
  blank = false
  await dialog.getByRole('button', { name: 'Try again' }).click()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('folder-path')).toHaveValue(path.join(tmpRoot, DIR))
  await page.keyboard.press('Escape')
})
