import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, openLibrary, pageOverflow, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 Sort tab, sort by condition: the library's search as the condition (or
 * the picks), one destination with an optional split into subfolders, a real
 * background move or copy into temp folders, and an undo that puts files back
 * and says which ones it could not. Runs on the isolated test server only.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4sortruletoken'
const PREFIX = 'v4sortrule-'
const COUNT = 6
const DIR = 'v4-sort-rules'
const DEST = 'v4-sort-rules-dest'
const destOf = (name: string) => path.join(tmpRoot, DEST, name)
const src = (name: string) => path.join(tmpRoot, DIR, name)

test.beforeAll(() => {
  fs.rmSync(path.join(tmpRoot, DEST), { recursive: true, force: true })
  for (const d of ['by-condition', 'copies', 'fit']) fs.mkdirSync(destOf(d), { recursive: true })
})

test.beforeEach(async ({ page }) => {
  // Every test starts from the seeded files where they belong, and without a saved one-at-a-time sort.
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  await page.request.delete('/api/sort/session')
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR, DEST])
})

async function toRules(page: Page) {
  await page.keyboard.press('Control+k')
  await page.getByTestId('palette').locator('input').fill('filter matches into folders')
  await expect(page.getByTestId('palette').getByRole('option').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await page.getByTestId('sort-mode-rules').click()
  await expect(page.getByTestId('sort-rule-dest')).toBeVisible()
}

async function chooseDestination(page: Page, folder: string) {
  await page.getByTestId('sort-rule-choose').click()
  const picker = page.getByTestId('sort-folder-picker')
  await picker.getByTestId('folder-path').fill(folder)
  await picker.getByTestId('folder-path').press('Enter')
  await expect(picker.getByTestId('folder-target')).toContainText(folder)
  await picker.getByRole('button', { name: 'Use this folder' }).click()
  await expect(picker).toHaveCount(0)
}

async function names(page: Page): Promise<string[]> {
  const tiles = page.getByTestId('tile')
  const out: string[] = []
  for (let i = 0; i < (await tiles.count()); i++) out.push((await tiles.nth(i).getAttribute('title'))!)
  return out
}

const run = (page: Page) => page.getByTestId('sort-rules-run')

test('the library search moves every match into subfolders; undo puts them back and names the one it cannot', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const files = await names(page)
  await toRules(page)

  // the condition starts from the library's search, and counts its matches
  await expect(page.getByTestId('sort-condition-input')).toHaveValue(TOKEN)
  await expect(page.getByTestId('sort-condition-count')).toHaveText(`${COUNT} match`)
  await expect(page.getByTestId('sort-start')).toBeDisabled()
  const dest = destOf('by-condition')
  await chooseDestination(page, dest)
  await page.getByTestId('sort-split-generator').check()
  await page.getByTestId('sort-start').click()
  const confirm = page.getByTestId('sort-confirm')
  await expect(confirm).toContainText('Moves 6 images')
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await confirm.getByRole('button', { name: 'Move 6 images' }).click()

  await expect(run(page)).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('sort-rules-headline')).toContainText('Moved 6 images into')
  for (const name of files) {
    expect(fs.existsSync(path.join(dest, 'nai', name)), `${name} moved`).toBe(true)
    expect(fs.existsSync(src(name))).toBe(false)
  }
  // the run is a job in the Jobs drawer too
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer')).toContainText('Sorted 6 images by condition')
  await page.keyboard.press('Escape')

  // someone puts another file where the first one came from; undo leaves that one
  fs.writeFileSync(src(files[0]!), 'not the same image')
  await page.getByTestId('sort-rules-undo').click()
  await expect(run(page)).toHaveAttribute('data-kind', 'undo')
  await expect(run(page)).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('sort-rules-headline')).toHaveText('Undone: 5 images are back where they were.')
  await expect(page.getByTestId('sort-rules-failures')).toContainText(files[0]!)
  await expect(page.getByTestId('sort-rules-failures')).toContainText('Another file with the same name is in its old place')
  for (const name of files.slice(1)) {
    expect(fs.existsSync(src(name)), `${name} back`).toBe(true)
    expect(fs.existsSync(path.join(dest, 'nai', name))).toBe(false)
  }
  expect(fs.existsSync(path.join(dest, 'nai', files[0]!))).toBe(true)
  await expect(page.getByTestId('sort-rules-undo')).toHaveCount(0)

  // a reload comes back to the same run; then the setup remembers it
  await page.reload()
  await expect(run(page)).toHaveAttribute('data-kind', 'undo')
  await expect(page.getByTestId('sort-rules-failures')).toContainText(files[0]!)
  await page.getByTestId('sort-rules-again').click()
  await expect(page.getByTestId('sort-rules-last')).toContainText('was undone')
  fs.rmSync(src(files[0]!))
  fs.renameSync(path.join(dest, 'nai', files[0]!), src(files[0]!))
})

test('picks can be copied without a split; undo deletes the copies and keeps the originals', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, TOKEN, COUNT)
  const tiles = page.getByTestId('tile')
  const picked: string[] = []
  for (const i of [1, 3, 4]) {
    await tiles.nth(i).click({ modifiers: ['Control'] })
    picked.push((await tiles.nth(i).getAttribute('title'))!)
  }
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Sort into folders…' }).click()
  await page.getByTestId('sort-mode-rules').click()
  await expect(page.getByTestId('sort-source')).toContainText('The 3 picked')
  await page.getByTestId('sort-op-copy').check()
  const dest = destOf('copies')
  await chooseDestination(page, dest)
  await page.getByTestId('sort-split-none').check()
  await expect(page.getByTestId('sort-start')).toHaveText('Copy 3 images…')
  await page.getByTestId('sort-start').click()
  await page.getByTestId('sort-confirm').getByRole('button', { name: 'Copy 3 images' }).click()

  await expect(run(page)).toHaveAttribute('data-status', 'done')
  for (const name of picked) {
    expect(fs.existsSync(path.join(dest, name))).toBe(true)
    expect(fs.existsSync(src(name))).toBe(true)
  }
  await page.getByTestId('sort-rules-undo').click()
  await expect(run(page)).toHaveAttribute('data-kind', 'undo')
  await expect(page.getByTestId('sort-rules-headline')).toHaveText('Undone: 3 copies deleted.')
  for (const name of picked) {
    expect(fs.existsSync(path.join(dest, name))).toBe(false)
    expect(fs.existsSync(src(name))).toBe(true)
  }
})

test('a preset keeps the condition, the folder and the split', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  await toRules(page)
  const dest = destOf('by-condition')
  await chooseDestination(page, dest)
  await page.getByTestId('sort-split-rating').check()
  await page.getByTestId('sort-preset-save').click()
  await page.getByTestId('sort-preset-name').fill('Stars out')
  await page.getByTestId('sort-preset-confirm').click()

  await page.getByTestId('sort-condition-input').fill('gen:comfyui')
  await page.getByTestId('sort-split-none').check()
  await page.getByTestId('sort-mode-slots').click()
  await page.getByTestId('sort-presets').locator('[data-preset="Stars out"]').getByRole('button', { name: /^Stars out/ }).click()
  await expect(page.getByTestId('sort-mode-rules')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('sort-condition-input')).toHaveValue(TOKEN)
  await expect(page.getByTestId('sort-split-rating')).toBeChecked()
  await expect(page.getByTestId('sort-rule-dest')).toContainText('by-condition')
})

for (const viewport of VIEWPORTS) {
  test(`setup and run fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      await openLibrary(page, TOKEN, COUNT, theme)
      await toRules(page)
      if (!(await page.getByTestId('sort-rule-dest').textContent())?.includes('fit')) await chooseDestination(page, destOf('fit'))
      await page.getByTestId('sort-op-copy').check()
      await expect(page.getByTestId('sort-start')).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.getByTestId('sort-start').click()
      await page.getByTestId('sort-confirm').getByRole('button', { name: /Copy/ }).click()
      await expect(run(page)).toHaveAttribute('data-status', 'done')
      for (const id of ['sort-rules-undo', 'sort-rules-open', 'sort-rules-again', 'sort-rules-back']) {
        await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
      }
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.getByTestId('sort-rules-undo').click()
      await expect(run(page)).toHaveAttribute('data-kind', 'undo')
      await expect(run(page)).toHaveAttribute('data-status', 'done')
      await page.getByTestId('sort-rules-again').click()
    }
  })
}
